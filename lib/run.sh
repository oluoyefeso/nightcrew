#!/usr/bin/env bash
# Core run loop — the heart of NightCrew

MAX_RETRIES=5
BACKOFF_BASE=300  # 5 minutes

CURRENT_TASK_ID=""
REPO_DIR=""
LAST_INPUT_TOKENS=0
LAST_OUTPUT_TOKENS=0

# Signal handler for clean shutdown
cleanup_on_signal() {
  log "Signal received. Cleaning up..."
  if [[ -n "${CURRENT_TASK_ID:-}" && -n "${REPO_DIR:-}" ]]; then
    local wt="$REPO_DIR/$WORKTREE_BASE/$CURRENT_TASK_ID"
    if [[ -d "$wt" ]]; then
      git -C "$wt" add -A 2>/dev/null || true
      git -C "$wt" commit -m "WIP: interrupted by signal" 2>/dev/null || true
    fi
    mark_task "paused" "$CURRENT_TASK_ID"
  fi
  if [[ -n "${REPO_DIR:-}" ]]; then
    git -C "$REPO_DIR" worktree prune 2>/dev/null || true
  fi
  log "State saved. Re-run 'nightcrew run' to resume."
  exit 1
}

# Validate dependency graph: check for missing IDs, cycles, and ordering
validate_dependencies() {
  local tasks_file="$1"
  local task_count
  task_count=$(yq e '.tasks | length' "$tasks_file")
  local errors=0

  # Build ID list and position map
  declare -A id_positions
  local all_ids=()
  for i in $(seq 0 $((task_count - 1))); do
    local tid
    tid=$(yq e ".tasks[$i].id" "$tasks_file")
    id_positions["$tid"]=$i
    all_ids+=("$tid")
  done

  # Check for missing dependency IDs and ordering
  for i in $(seq 0 $((task_count - 1))); do
    local tid
    tid=$(yq e ".tasks[$i].id" "$tasks_file")
    local deps
    deps=$(yq e '.tasks['"$i"'].depends_on // [] | .[]' "$tasks_file" 2>/dev/null)
    for dep in $deps; do
      if [[ -z "${id_positions[$dep]+x}" ]]; then
        log_error "PREFLIGHT: Task '$tid' depends on unknown task '$dep'"
        ((errors++))
      elif [[ ${id_positions[$dep]} -ge $i ]]; then
        log "WARNING: Task '$tid' depends on '$dep' but '$dep' is listed after it. Reorder tasks.yaml."
      fi
    done
  done

  # Cycle detection via DFS with path tracking
  declare -A visited  # 0=unvisited, 1=in-path, 2=done
  local has_cycle=false

  _dfs_cycle_check() {
    local node="$1"
    visited["$node"]=1  # in-path

    local idx="${id_positions[$node]}"
    local deps
    deps=$(yq e '.tasks['"$idx"'].depends_on // [] | .[]' "$tasks_file" 2>/dev/null)
    for dep in $deps; do
      [[ -z "${id_positions[$dep]+x}" ]] && continue  # skip missing (already reported)
      if [[ "${visited[$dep]:-0}" == "1" ]]; then
        log_error "PREFLIGHT: Circular dependency detected: $node -> $dep"
        has_cycle=true
        return
      elif [[ "${visited[$dep]:-0}" == "0" ]]; then
        _dfs_cycle_check "$dep"
        [[ "$has_cycle" == "true" ]] && return
      fi
    done
    visited["$node"]=2  # done
  }

  for tid in "${all_ids[@]}"; do
    if [[ "${visited[$tid]:-0}" == "0" ]]; then
      _dfs_cycle_check "$tid"
      [[ "$has_cycle" == "true" ]] && ((errors++)) && break
    fi
  done

  return $errors
}

preflight_check() {
  local missing=()
  command -v claude >/dev/null || missing+=("claude")
  command -v gh >/dev/null || missing+=("gh")
  command -v jq >/dev/null || missing+=("jq")
  command -v yq >/dev/null || missing+=("yq")
  command -v envsubst >/dev/null || missing+=("envsubst (gettext)")

  if [[ ${#missing[@]} -gt 0 ]]; then
    log_error "Missing dependencies: ${missing[*]}"
    log_error "Install them and try again."
    exit 1
  fi

  # Verify gh is authenticated
  if ! gh auth status >/dev/null 2>&1; then
    log_error "GitHub CLI not authenticated. Run 'gh auth login' first."
    exit 1
  fi
}

# JSON output format support flag (set during preflight_validate, read by run_with_retry)
# Must call preflight_validate() before run_with_retry() for accurate cost tracking.
JSON_OUTPUT_SUPPORTED=false

# Full preflight validation: schema, deps, git state, JSON output support
preflight_validate() {
  local tasks_file="$1"
  local config_file="$2"
  local checks_passed=0
  local checks_total=0
  local checks_warned=0

  log "Running preflight validation..."

  # 1. Schema validation
  ((checks_total++))
  local schema_file="$NIGHTCREW_DIR/schemas/task.schema.json"
  if [[ ! -f "$schema_file" ]]; then
    log "WARNING: Schema file not found ($schema_file). Skipping schema validation."
    ((checks_warned++))
  else
    # Convert YAML to JSON and validate structure
    local json_tmp
    json_tmp=$(mktemp /tmp/nightcrew-validate-XXXXXXXX.json)
    if ! yq e -o=json '.' "$tasks_file" > "$json_tmp" 2>/dev/null; then
      log_error "PREFLIGHT: tasks.yaml is not valid YAML"
      rm -f "$json_tmp"
      return 1
    fi

    # Check required fields per task
    local task_count
    task_count=$(jq '.tasks | length' "$json_tmp")
    local schema_errors=0
    for i in $(seq 0 $((task_count - 1))); do
      for field in id title branch type prompt; do
        local val
        val=$(jq -r ".tasks[$i].$field // empty" "$json_tmp")
        if [[ -z "$val" ]]; then
          log_error "PREFLIGHT: Task $i missing required field '$field'"
          ((schema_errors++))
        fi
      done
      # Validate type enum
      local task_type
      task_type=$(jq -r ".tasks[$i].type // empty" "$json_tmp")
      if [[ -n "$task_type" ]] && ! echo "$task_type" | grep -qE '^(research|implementation|refactor|test)$'; then
        log_error "PREFLIGHT: Task $i has invalid type '$task_type' (must be research|implementation|refactor|test)"
        ((schema_errors++))
      fi
      # Validate complexity enum
      local complexity
      complexity=$(jq -r ".tasks[$i].complexity // empty" "$json_tmp")
      if [[ -n "$complexity" ]] && ! echo "$complexity" | grep -qE '^(low|medium|high)$'; then
        log_error "PREFLIGHT: Task $i has invalid complexity '$complexity' (must be low|medium|high)"
        ((schema_errors++))
      fi
    done
    rm -f "$json_tmp"

    if [[ $schema_errors -gt 0 ]]; then
      log_error "PREFLIGHT: Schema validation failed ($schema_errors errors)"
      return 1
    fi
    log "  [OK] Schema validation passed ($task_count tasks)"
    ((checks_passed++))
  fi

  # 2. Dependency graph validation
  ((checks_total++))
  if validate_dependencies "$tasks_file"; then
    log "  [OK] Dependency graph is valid"
    ((checks_passed++))
  else
    log_error "PREFLIGHT: Dependency validation failed"
    return 1
  fi

  # 3. Prompt template rendering check
  ((checks_total++))
  local template_dir="$NIGHTCREW_DIR/templates"
  local template_ok=true
  for tmpl in plan-prompt.md system-prompt.md review-prompt.md; do
    if [[ ! -f "$template_dir/$tmpl" ]]; then
      log_error "PREFLIGHT: Template missing: $template_dir/$tmpl"
      template_ok=false
    fi
  done
  if [[ "$template_ok" == "true" ]]; then
    # Quick envsubst test with dummy vars
    export TASK_ID="test" TASK_TITLE="test" TASK_PROMPT="test" TASK_GOAL="test"
    export TASK_BRANCH="test" TASK_FILES_IN_SCOPE="test" RESUME_CONTEXT="" BASE_BRANCH="main"
    local rendered
    rendered=$(envsubst < "$template_dir/system-prompt.md" 2>/dev/null)
    unset TASK_ID TASK_TITLE TASK_PROMPT TASK_GOAL TASK_BRANCH TASK_FILES_IN_SCOPE RESUME_CONTEXT BASE_BRANCH
    if [[ -z "$rendered" ]]; then
      log_error "PREFLIGHT: Template rendering produced empty output"
      return 1
    fi
    log "  [OK] Templates render successfully"
    ((checks_passed++))
  else
    return 1
  fi

  # 4. Git state checks
  ((checks_total++))
  local repo_dir
  repo_dir=$(config_get "repo_path" "$(pwd)" "$config_file")
  if [[ ! -d "$repo_dir/.git" ]]; then
    log_error "PREFLIGHT: Not a git repository: $repo_dir"
    return 1
  fi
  local dirty
  dirty=$(git -C "$repo_dir" status --porcelain 2>/dev/null | head -1)
  if [[ -n "$dirty" ]]; then
    log "WARNING: Working tree has uncommitted changes in $repo_dir"
    ((checks_warned++))
  fi
  log "  [OK] Git repository verified"
  ((checks_passed++))

  # 5. JSON output format support
  ((checks_total++))
  if claude --help 2>&1 | grep -q 'output-format'; then
    JSON_OUTPUT_SUPPORTED=true
    log "  [OK] JSON output format supported (real cost tracking enabled)"
  else
    JSON_OUTPUT_SUPPORTED=false
    log "  [--] JSON output format not supported (using flat-rate cost estimates)"
  fi
  ((checks_passed++))

  # 6. Optional: bats availability
  ((checks_total++))
  if command -v bats >/dev/null 2>&1; then
    log "  [OK] bats test runner available"
  else
    log "  [--] bats not installed (tests won't run). Install: brew install bats-core"
  fi
  ((checks_passed++))

  log "PREFLIGHT: $checks_passed/$checks_total checks passed ($checks_warned warnings)"
  return 0
}

# Run claude -p with rate limit retry and exponential backoff
run_with_retry() {
  local prompt="$1"
  local model="$2"
  local tools="$3"
  local prompt_file="$4"
  local max_time="$5"
  local log_file="$6"
  local worktree_dir="$7"

  local attempt=0

  while [[ $attempt -lt $MAX_RETRIES ]]; do
    local stderr_file
    stderr_file=$(mktemp /tmp/nightcrew-stderr-XXXXXXXX)

    log "Running claude -p (model: $model, attempt: $((attempt+1))/$MAX_RETRIES)..."

    local exit_code=0

    if [[ "$JSON_OUTPUT_SUPPORTED" == "true" ]]; then
      # JSON output mode: capture full JSON to temp file, extract text and tokens
      local json_output_file
      json_output_file=$(mktemp /tmp/nightcrew-json-XXXXXXXX.json)
      timeout --signal=TERM --kill-after=60 "${max_time}m" \
        claude -p "$prompt" \
          --model "$model" \
          --allowedTools "$tools" \
          --system-prompt-file "$prompt_file" \
          --output-format json \
        > "$json_output_file" 2>"$stderr_file" || exit_code=$?

      if [[ $exit_code -eq 0 && -s "$json_output_file" ]]; then
        # Extract text content for the log file
        jq -r '.result // .content // .' "$json_output_file" > "$log_file" 2>/dev/null || \
          cp "$json_output_file" "$log_file"
        # Extract token usage and store for cost calculation
        local token_data
        token_data=$(parse_token_usage "$json_output_file")
        LAST_INPUT_TOKENS=$(echo "$token_data" | cut -d' ' -f1)
        LAST_OUTPUT_TOKENS=$(echo "$token_data" | cut -d' ' -f2)
      else
        # JSON parsing failed or empty output, copy raw
        [[ -s "$json_output_file" ]] && cp "$json_output_file" "$log_file"
        LAST_INPUT_TOKENS=0
        LAST_OUTPUT_TOKENS=0
      fi
      rm -f "$json_output_file"
    else
      # Legacy mode: pipe through tee, flat-rate cost estimate
      timeout --signal=TERM --kill-after=60 "${max_time}m" \
        claude -p "$prompt" \
          --model "$model" \
          --allowedTools "$tools" \
          --system-prompt-file "$prompt_file" \
        2>"$stderr_file" | tee "$log_file" || exit_code=$?
      LAST_INPUT_TOKENS=0
      LAST_OUTPUT_TOKENS=0
    fi

    local stderr_content
    stderr_content=$(cat "$stderr_file" 2>/dev/null || true)
    rm -f "$stderr_file"

    # Timeout (exit code 124 from GNU timeout, or 142 from perl alarm)
    if [[ $exit_code -eq 124 || $exit_code -eq 142 ]]; then
      log_error "Task timed out after ${max_time} minutes"
      return 124
    fi

    # Success
    if [[ $exit_code -eq 0 ]]; then
      return 0
    fi

    # Rate limit detection
    if echo "$stderr_content" | grep -qiE "rate limit|too many requests|429|capacity|exceeded.*limit"; then
      local sleep_secs=$(( BACKOFF_BASE * (2 ** attempt) ))
      [[ $sleep_secs -gt 3600 ]] && sleep_secs=3600  # cap at 1 hour

      log "Rate limit hit (attempt $((attempt+1))/$MAX_RETRIES). Sleeping ${sleep_secs}s..."

      # Save WIP before sleeping
      commit_changes "$worktree_dir" "WIP: rate limit pause (attempt $((attempt+1)))"
      sleep "$sleep_secs"
      ((attempt++))
      continue
    fi

    # Non-rate-limit failure
    log_error "claude -p failed with exit code $exit_code"
    if [[ -n "$stderr_content" ]]; then
      log_error "stderr: $stderr_content"
    fi
    return $exit_code
  done

  log_error "Rate limit retries exhausted ($MAX_RETRIES attempts)"
  return 1
}

render_pr_body() {
  local task_id="$1"
  local task_title="$2"
  local worktree_dir="$3"
  local template_dir="$4"
  local base_branch="${5:-main}"

  local diff_stat
  diff_stat=$(git -C "$worktree_dir" diff --stat "$base_branch"...HEAD 2>/dev/null || echo "No changes")

  local decisions=""
  if [[ -f "$worktree_dir/DECISIONS-${task_id}.md" ]]; then
    decisions=$(cat "$worktree_dir/DECISIONS-${task_id}.md")
  fi

  local plan_summary=""
  if [[ -f "$worktree_dir/PLAN-${task_id}.md" ]]; then
    # Extract just the scope decision and architecture decisions sections
    plan_summary=$(sed -n '/^## Scope Decision/,/^## [^S]/p' "$worktree_dir/PLAN-${task_id}.md" | head -30)
    if [[ -z "$plan_summary" ]]; then
      plan_summary="Plan file exists. See PLAN-${task_id}.md for details."
    fi
  fi

  local review_summary=""
  if [[ -f "$worktree_dir/REVIEW-${task_id}.md" ]]; then
    review_summary=$(cat "$worktree_dir/REVIEW-${task_id}.md")
  fi

  cat <<EOF
## NightCrew: $task_title

This PR was created autonomously by [NightCrew](https://github.com/nightcrew) using a 3-phase pipeline:
1. **Plan** (Opus) — Engineering review and implementation plan
2. **Implement** (Sonnet) — Code changes following the plan
3. **Review** (Sonnet) — Pre-landing code review with auto-fixes

### Changes
\`\`\`
$diff_stat
\`\`\`

### Planning Summary
${plan_summary:-No plan file generated (direct implementation).}

### Decisions Made
${decisions:-No autonomous decisions were needed for this task.}

### Review Findings
${review_summary:-No review concerns flagged. All findings were auto-fixed.}

---
*Generated by NightCrew. Review carefully before merging.*
EOF
}

# Send completion notification (macOS + webhook)
send_notification() {
  local config_file="$1"
  local completed="$2"
  local failed="$3"
  local blocked="$4"

  local summary="NightCrew: $completed completed, $failed failed, $blocked blocked"

  # macOS native notification
  local macos_enabled
  macos_enabled=$(config_get "notifications.macos" "false" "$config_file")
  if [[ "$macos_enabled" == "true" ]]; then
    # Only attempt if running on macOS with a GUI session
    if [[ "$(uname)" == "Darwin" ]] && pgrep -q WindowServer 2>/dev/null; then
      osascript -e "display notification \"$summary\" with title \"NightCrew\"" 2>/dev/null || \
        log "DEBUG: macOS notification failed (non-blocking)"
    fi
  fi

  # Webhook notification
  local webhook_url
  webhook_url=$(config_get "notifications.webhook_url" "" "$config_file")
  if [[ -n "$webhook_url" ]]; then
    local total_cost
    total_cost=$(get_total_cost)
    curl -s --max-time 10 -X POST "$webhook_url" \
      -H 'Content-Type: application/json' \
      -d "{\"event\":\"run_complete\",\"completed\":$completed,\"failed\":$failed,\"blocked\":$blocked,\"total_cost_cents\":$total_cost}" \
      >/dev/null 2>&1 || \
      log "WARNING: Webhook notification failed (non-blocking)"
  fi
}

nightcrew_run() {
  local tasks_file="$1"
  local config_file="$2"
  local dry_run="${3:-false}"

  trap cleanup_on_signal SIGINT SIGTERM SIGHUP

  # Pre-flight: check dependencies are installed
  preflight_check

  if [[ ! -f "$tasks_file" ]]; then
    log_error "Tasks file not found: $tasks_file"
    exit 1
  fi

  # Full preflight validation (schema, deps, templates, git)
  if ! preflight_validate "$tasks_file" "$config_file"; then
    log_error "Preflight validation failed. Fix the issues above and re-run."
    exit 1
  fi

  # Resolve repo path (git validation already done in preflight_validate)
  REPO_DIR=$(config_get "repo_path" "$(pwd)" "$config_file")
  REPO_DIR=$(cd "$REPO_DIR" && pwd)  # resolve to absolute

  local base_branch
  base_branch=$(config_get "pr_defaults.base" "main" "$config_file")
  local max_task_time
  max_task_time=$(config_get "max_task_time_minutes" "45" "$config_file")
  local template_dir="$NIGHTCREW_DIR/templates"

  # Init state
  init_state "$NIGHTCREW_DIR"

  # Parse tasks
  local task_count
  task_count=$(yq e '.tasks | length' "$tasks_file")
  log "NightCrew starting. $task_count tasks queued."
  log "Repo: $REPO_DIR"
  log "Config: $config_file"

  local completed=0
  local failed=0
  local skipped=0
  local blocked=0

  for i in $(seq 0 $((task_count - 1))); do
    # Read task fields
    local task_id task_title task_branch task_type task_complexity task_prompt
    local task_goal task_files task_max_time task_test_cmd task_custom_tools
    task_id=$(yq e ".tasks[$i].id" "$tasks_file")
    task_title=$(yq e ".tasks[$i].title" "$tasks_file")
    task_branch=$(yq e ".tasks[$i].branch" "$tasks_file")
    task_type=$(yq e ".tasks[$i].type // \"implementation\"" "$tasks_file")
    task_complexity=$(yq e ".tasks[$i].complexity // \"medium\"" "$tasks_file")
    task_prompt=$(yq e ".tasks[$i].prompt" "$tasks_file")
    task_goal=$(yq e ".tasks[$i].goal // \"\"" "$tasks_file")
    task_files=$(yq e '.tasks['"$i"'].files_in_scope // [] | join(" ")' "$tasks_file")
    task_max_time=$(yq e ".tasks[$i].max_time_minutes // \"$max_task_time\"" "$tasks_file")
    task_test_cmd=$(yq e ".tasks[$i].test_command // \"\"" "$tasks_file")
    task_custom_tools=$(yq e ".tasks[$i].allowed_tools // \"\"" "$tasks_file")
    local task_depends_on
    task_depends_on=$(yq e '.tasks['"$i"'].depends_on // [] | join(" ")' "$tasks_file")

    log "────────────────────────────────────────"
    log "Task $((i+1))/$task_count: $task_title [$task_id]"

    # Skip completed
    local status
    status=$(get_task_status "$task_id")
    if [[ "$status" == "complete" ]]; then
      log "Skipping (already complete)"
      ((skipped++))
      continue
    fi

    # Dependency check (inline — blocked tasks are re-evaluated on re-run)
    if [[ -n "$task_depends_on" ]]; then
      local dep_blocked=false
      local blocking_dep=""
      for dep_id in $task_depends_on; do
        local dep_status
        dep_status=$(get_task_status "$dep_id")
        if [[ "$dep_status" != "complete" ]]; then
          dep_blocked=true
          blocking_dep="$dep_id"
          break
        fi
      done
      if [[ "$dep_blocked" == "true" ]]; then
        local blocker_status
        blocker_status=$(get_task_status "$blocking_dep")
        log "Skipping: dependency '$blocking_dep' is $blocker_status (not complete)"
        mark_task "blocked" "$task_id" "$blocking_dep"
        ((blocked++))
        continue
      fi
    fi

    # Cost cap check
    if ! check_cost_cap "$config_file"; then
      log "Stopping: cost cap reached."
      break
    fi

    # Protected branch check
    if is_protected_branch "$task_branch" "$config_file"; then
      log_error "Refusing to work on protected branch: $task_branch"
      mark_task "failed" "$task_id" "protected branch"
      ((failed++))
      continue
    fi

    if [[ "$dry_run" == "true" ]]; then
      local plan_model impl_model review_model
      plan_model=$(route_model "$task_type" "$task_complexity" "$config_file" "plan")
      impl_model=$(route_model "$task_type" "$task_complexity" "$config_file" "implement")
      review_model=$(route_model "$task_type" "$task_complexity" "$config_file" "review")
      local tools
      tools=$(route_tools "$task_type" "$task_custom_tools")
      log "[DRY RUN] Would run 3-phase pipeline:"
      log "  Phase 1 (plan):       $plan_model"
      log "  Phase 2 (implement):  $impl_model"
      log "  Phase 3 (review):     $review_model"
      log "  Branch: $task_branch"
      log "  Tools: $tools"
      log "  Timeout: ${task_max_time}m per phase"
      continue
    fi

    # Set current task for signal handler
    CURRENT_TASK_ID="$task_id"
    mark_task "in_progress" "$task_id"

    # Set up worktree
    local worktree_dir
    worktree_dir=$(setup_worktree "$REPO_DIR" "$task_id" "$task_branch" "$base_branch") || {
      log_error "Worktree setup failed for task $task_id"
      mark_task "failed" "$task_id" "worktree setup failed"
      ((failed++))
      CURRENT_TASK_ID=""
      continue
    }

    # Guard: validate worktree path before using it downstream
    if [[ -z "$worktree_dir" || "$worktree_dir" == *$'\n'* ]]; then
      log_error "Worktree path invalid (empty or multiline): $(echo "$worktree_dir" | head -1)"
      mark_task "failed" "$task_id" "worktree setup returned invalid path"
      ((failed++))
      CURRENT_TASK_ID=""
      continue
    fi
    if [[ ! -d "$worktree_dir" ]]; then
      log_error "Worktree directory does not exist: $worktree_dir"
      mark_task "failed" "$task_id" "worktree directory missing"
      ((failed++))
      CURRENT_TASK_ID=""
      continue
    fi

    log "Worktree: $worktree_dir"

    # Route tools (same for all phases — plan only reads, review reads+fixes)
    local tools
    tools=$(route_tools "$task_type" "$task_custom_tools")

    # Plan file location (written by phase 1, consumed by phase 2)
    local plan_file="$worktree_dir/PLAN-${task_id}.md"

    # ─────────────────────────────────────────────────
    # PHASE 1: PLAN (Opus — architectural reasoning)
    # ─────────────────────────────────────────────────
    local plan_model
    plan_model=$(route_model "$task_type" "$task_complexity" "$config_file" "plan")
    log "Phase 1/3: Planning with $plan_model..."

    local plan_prompt_file
    plan_prompt_file=$(build_plan_prompt \
      "$task_id" "$task_title" "$task_prompt" "$task_goal" \
      "$task_branch" "$task_files" \
      "$template_dir" "$worktree_dir" "$base_branch")

    # Plan uses read-only tools + write (to save the plan file)
    local plan_tools="Read,Grep,Glob,Write,Bash(git diff*),Bash(git log*),Bash(git status*)"

    local plan_log="$NIGHTCREW_DIR/logs/${task_id}-plan-$(date +%s).log"

    # The plan prompt instructs Claude to output a structured plan.
    # We capture it and save it as the plan file.
    local plan_user_prompt="Analyze this task and produce a complete implementation plan. Save the plan to PLAN-${task_id}.md at the repo root.

Task: $task_title
$task_prompt"

    local plan_exit=0
    # Plan gets half the task timeout (planning should be faster than implementation)
    local plan_timeout=$(( task_max_time / 2 ))
    [[ $plan_timeout -lt 10 ]] && plan_timeout=10
    run_with_retry "$plan_user_prompt" "$plan_model" "$plan_tools" "$plan_prompt_file" "$plan_timeout" "$plan_log" "$worktree_dir" || plan_exit=$?
    rm -f "$plan_prompt_file"

    # Track plan cost
    local plan_cost
    plan_cost=$(estimate_cost_cents "$plan_model" "$LAST_INPUT_TOKENS" "$LAST_OUTPUT_TOKENS")
    add_cost "$plan_cost"

    if [[ $plan_exit -ne 0 ]]; then
      log_error "Planning phase failed (exit $plan_exit). Falling back to direct implementation."
      # Clear plan file if planning failed — implementation will proceed without it
      rm -f "$plan_file"
    elif [[ -f "$plan_file" ]]; then
      log "Plan saved: PLAN-${task_id}.md"
      set_task_field "$task_id" "plan_file" "$plan_file"
    else
      log "Warning: Planning completed but no plan file written. Proceeding without plan."
    fi

    # ─────────────────────────────────────────────────
    # PHASE 2: IMPLEMENT (Sonnet — follows the plan)
    # ─────────────────────────────────────────────────
    local impl_model
    impl_model=$(route_model "$task_type" "$task_complexity" "$config_file" "implement")
    log "Phase 2/3: Implementing with $impl_model..."

    local impl_prompt_file
    impl_prompt_file=$(build_impl_prompt \
      "$task_id" "$task_title" "$task_prompt" "$task_goal" \
      "$task_branch" "$task_files" \
      "$template_dir" "$worktree_dir" "$base_branch" "$plan_file")

    local impl_log="$NIGHTCREW_DIR/logs/${task_id}-impl-$(date +%s).log"

    local run_exit=0
    run_with_retry "$task_prompt" "$impl_model" "$tools" "$impl_prompt_file" "$task_max_time" "$impl_log" "$worktree_dir" || run_exit=$?
    rm -f "$impl_prompt_file"

    # Track implementation cost
    local impl_cost
    impl_cost=$(estimate_cost_cents "$impl_model" "$LAST_INPUT_TOKENS" "$LAST_OUTPUT_TOKENS")
    add_cost "$impl_cost"
    set_task_field "$task_id" "model" "$impl_model"
    set_task_field "$task_id" "log_file" "$impl_log"

    if [[ $run_exit -eq 124 ]]; then
      commit_changes "$worktree_dir" "WIP: $task_title (timed out)"
      mark_task "timeout" "$task_id"
      ((failed++))
      log_error "Implementation timed out: $task_id"
      cleanup_worktree "$REPO_DIR" "$task_id"
      CURRENT_TASK_ID=""
      continue
    fi

    if [[ $run_exit -ne 0 ]]; then
      commit_changes "$worktree_dir" "WIP: $task_title (failed)"
      mark_task "failed" "$task_id" "implementation exit code $run_exit"
      ((failed++))
      log_error "Implementation failed: $task_id"
      cleanup_worktree "$REPO_DIR" "$task_id"
      CURRENT_TASK_ID=""
      continue
    fi

    # Commit implementation before review
    commit_changes "$worktree_dir" "feat($task_id): $task_title"

    # ─────────────────────────────────────────────────
    # PHASE 3: REVIEW (Sonnet — pre-PR code review)
    # ─────────────────────────────────────────────────
    local review_model
    review_model=$(route_model "$task_type" "$task_complexity" "$config_file" "review")
    log "Phase 3/3: Reviewing with $review_model..."

    local review_prompt_file
    review_prompt_file=$(build_review_prompt \
      "$task_id" "$task_title" "$task_prompt" "$task_goal" \
      "$task_branch" "$task_files" \
      "$template_dir" "$worktree_dir" "$base_branch")

    local review_tools="Read,Grep,Glob,Write,Edit,Bash(git diff*),Bash(git log*),Bash(git status*),Bash(git fetch*),Bash(git add*)"
    local review_log="$NIGHTCREW_DIR/logs/${task_id}-review-$(date +%s).log"

    local review_user_prompt="Review the diff on branch $task_branch against $base_branch. Auto-fix mechanical issues. Log concerns to REVIEW-${task_id}.md."

    local review_exit=0
    local review_timeout=$(( task_max_time / 3 ))
    [[ $review_timeout -lt 10 ]] && review_timeout=10
    run_with_retry "$review_user_prompt" "$review_model" "$review_tools" "$review_prompt_file" "$review_timeout" "$review_log" "$worktree_dir" || review_exit=$?
    rm -f "$review_prompt_file"

    # Track review cost
    local review_cost
    review_cost=$(estimate_cost_cents "$review_model" "$LAST_INPUT_TOKENS" "$LAST_OUTPUT_TOKENS")
    add_cost "$review_cost"

    if [[ $review_exit -ne 0 ]]; then
      log "Warning: Review phase failed (exit $review_exit). Proceeding with unreviewed code."
      # Review failure is non-blocking — the code was already implemented
    else
      # Commit any auto-fixes from the review
      commit_changes "$worktree_dir" "fix($task_id): auto-fixes from pre-landing review"
      log "Review complete."
    fi

    # ─────────────────────────────────────────────────
    # VALIDATE + PUSH + PR
    # ─────────────────────────────────────────────────
    log "Running validation..."
    local validation_exit=0
    validate_task "$worktree_dir" "$task_branch" "$task_files" "$task_test_cmd" "$base_branch" || validation_exit=$?

    if [[ $validation_exit -ne 0 ]]; then
      log_error "Validation failed with $validation_exit violation(s)"
      commit_changes "$worktree_dir" "WIP: $task_title (validation failed)"
      mark_task "failed" "$task_id" "validation failed"
      ((failed++))
      cleanup_worktree "$REPO_DIR" "$task_id"
      CURRENT_TASK_ID=""
      continue
    fi

    # Total cost for this task
    local total_task_cost=$(( plan_cost + impl_cost + review_cost ))
    set_task_field "$task_id" "cost_cents" "$total_task_cost"

    # Push and create PR
    log "Pushing branch $task_branch..."
    if push_branch "$worktree_dir" "$task_branch"; then
      local pr_body
      pr_body=$(render_pr_body "$task_id" "$task_title" "$worktree_dir" "$template_dir" "$base_branch")
      local pr_url
      pr_url=$(create_draft_pr "$worktree_dir" "$task_title" "$pr_body" "$base_branch")

      if [[ -n "$pr_url" ]]; then
        log "Draft PR created: $pr_url"
        set_task_field "$task_id" "pr_url" "$pr_url"
      fi
    else
      log_error "Failed to push branch $task_branch (no remote configured?)"
    fi

    mark_task "complete" "$task_id" "${pr_url:-}"
    ((completed++))
    log "Task complete: $task_id (plan: $plan_model, impl: $impl_model, review: $review_model)"

    # Cleanup worktree
    cleanup_worktree "$REPO_DIR" "$task_id"
    CURRENT_TASK_ID=""
  done

  # Summary
  log "════════════════════════════════════════"
  log "NightCrew session complete."
  log "  Completed: $completed"
  log "  Failed:    $failed"
  log "  Blocked:   $blocked"
  log "  Skipped:   $skipped"
  log "  Total cost: ~$(get_total_cost) cents"
  log "════════════════════════════════════════"

  # Write sentinel
  write_sentinel "$NIGHTCREW_DIR" "completed=$completed failed=$failed blocked=$blocked skipped=$skipped"

  # Send notifications
  send_notification "$config_file" "$completed" "$failed" "$blocked"
}
