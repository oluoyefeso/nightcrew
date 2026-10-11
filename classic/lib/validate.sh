#!/usr/bin/env bash
# Post-task validation checks

validate_task() {
  local worktree_dir="$1"
  local task_branch="$2"
  local files_in_scope="$3"
  local test_command="${4:-}"
  local base_branch="${5:-main}"

  local violations=0

  # 0. Guard: verify working directory is accessible
  if [[ ! -d "$worktree_dir" ]]; then
    log_error "VALIDATION: Worktree directory does not exist: $worktree_dir"
    return 1
  fi

  # 1. Branch assertion
  local current_branch
  current_branch=$(git -C "$worktree_dir" branch --show-current 2>/dev/null)
  if [[ "$current_branch" != "$task_branch" ]]; then
    log_error "VALIDATION: Wrong branch. Expected '$task_branch', got '$current_branch'"
    violations=$((violations + 1))
  fi

  # 2. File scope check (defense-in-depth)
  if [[ -n "$files_in_scope" && "$files_in_scope" != "**/*" ]]; then
    local changed_files
    changed_files=$(git -C "$worktree_dir" diff --name-only "$base_branch"...HEAD 2>/dev/null || true)

    # Also check unstaged/untracked
    local dirty_files
    dirty_files=$(git -C "$worktree_dir" status --porcelain 2>/dev/null | awk '{print $2}')

    local all_changed
    all_changed=$(echo -e "${changed_files}\n${dirty_files}" | sort -u | grep -v '^$' || true)

    while IFS= read -r file; do
      [[ -z "$file" ]] && continue
      # Allow NightCrew metadata files at repo root
      if [[ "$file" =~ ^(DECISIONS|PLAN|REVIEW)- ]]; then
        continue
      fi
      local in_scope=false
      for pattern in $files_in_scope; do
        # Convert ** glob to a regex for matching relative paths.
        # git diff --name-only returns paths like "src/auth/login.ts"
        # Pattern "src/auth/**" should match "src/auth/login.ts" and "src/auth/sub/file.ts"
        local regex
        regex=$(echo "$pattern" | sed 's|\.|\\.|g; s|\*\*/|DOUBLEWILD/|g; s|\*\*|DOUBLEWILD|g; s|\*|[^/]*|g; s|DOUBLEWILD|.*|g')
        regex="^${regex}$"
        if echo "$file" | grep -qE "$regex"; then
          in_scope=true
          break
        fi
      done
      if [[ "$in_scope" == "false" ]]; then
        log_error "VALIDATION: Out-of-scope file modified: $file"
        violations=$((violations + 1))
      fi
    done <<< "$all_changed"
  fi

  # 3. Secret scan
  local secrets_found
  secrets_found=$(git -C "$worktree_dir" diff "$base_branch"...HEAD 2>/dev/null | \
    grep -iE '^\+.*(api_key|secret_key|password|private_key)[[:space:]]*[=:]' | \
    grep -vF '+++' || true)
  if [[ -n "$secrets_found" ]]; then
    log_error "VALIDATION: Possible secrets detected in diff:"
    echo "$secrets_found" >&2
    violations=$((violations + 1))
  fi

  # 4. Test command
  if [[ -n "$test_command" ]]; then
    log "Running test command: $test_command"
    if ! (cd "$worktree_dir" && eval "$test_command" 2>&1); then
      log_error "VALIDATION: Test command failed: $test_command"
      violations=$((violations + 1))
    fi
  fi

  # 5. Large file check
  local large_files
  large_files=$(git -C "$worktree_dir" diff --stat "$base_branch"...HEAD 2>/dev/null | \
    awk '$3 > 10000 {print $1}' || true)
  if [[ -n "$large_files" ]]; then
    log_error "VALIDATION: Large file changes detected: $large_files"
    # Warning only, not a violation
  fi

  return $violations
}
