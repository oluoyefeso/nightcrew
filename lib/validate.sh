#!/usr/bin/env bash
# Post-task validation checks

validate_task() {
  local worktree_dir="$1"
  local task_branch="$2"
  local files_in_scope="$3"
  local test_command="${4:-}"
  local base_branch="${5:-main}"

  local violations=0

  # 1. Branch assertion
  local current_branch
  current_branch=$(git -C "$worktree_dir" branch --show-current 2>/dev/null)
  if [[ "$current_branch" != "$task_branch" ]]; then
    log_error "VALIDATION: Wrong branch. Expected '$task_branch', got '$current_branch'"
    ((violations++))
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
      local in_scope=false
      for pattern in $files_in_scope; do
        # Use find -path for proper ** glob matching.
        # find -path matches the full path, so prepend ./ to match relative patterns.
        # Convert ** to find's * (find -path treats * as matching across /).
        local find_pattern
        find_pattern=$(echo "$pattern" | sed 's|\*\*|*|g')
        if find "$worktree_dir" -path "$worktree_dir/$find_pattern" -print -quit 2>/dev/null | grep -q "$file"; then
          in_scope=true
          break
        fi
      done
      if [[ "$in_scope" == "false" ]]; then
        # Allow DECISIONS-*.md and PLAN-*.md and REVIEW-*.md at repo root
        if [[ "$file" =~ ^(DECISIONS|PLAN|REVIEW)- ]]; then
          continue
        fi
        log_error "VALIDATION: Out-of-scope file modified: $file"
        ((violations++))
      fi
    done <<< "$all_changed"
  fi

  # 3. Secret scan
  local secrets_found
  secrets_found=$(git -C "$worktree_dir" diff "$base_branch"...HEAD 2>/dev/null | \
    grep -iE '^\+.*(api_key|secret_key|password|private_key)\s*[=:]' | \
    grep -v '^\+\+\+' || true)
  if [[ -n "$secrets_found" ]]; then
    log_error "VALIDATION: Possible secrets detected in diff:"
    echo "$secrets_found" >&2
    ((violations++))
  fi

  # 4. Test command
  if [[ -n "$test_command" ]]; then
    log "Running test command: $test_command"
    if ! (cd "$worktree_dir" && eval "$test_command" 2>&1); then
      log_error "VALIDATION: Test command failed: $test_command"
      ((violations++))
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
