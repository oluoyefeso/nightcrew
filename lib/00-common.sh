#!/usr/bin/env bash
# Common utilities shared across all modules

# Logging with timestamps
log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

log_error() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $*" >&2
}

# Read a config value with default fallback
# Usage: config_get "key" "default" "config_file"
config_get() {
  local key="$1"
  local default="${2:-}"
  local config_file="${3:-./config.yaml}"

  if [[ -f "$config_file" ]]; then
    local val
    val=$(yq e ".$key // \"\"" "$config_file" 2>/dev/null)
    if [[ -n "$val" && "$val" != "null" ]]; then
      echo "$val"
      return
    fi
  fi
  echo "$default"
}

# Check if a branch is protected
# Usage: is_protected_branch branch [config_file] [extra_branches]
# extra_branches is a newline-separated list of additional protected branches
# (per-task list); it is unioned with the global list from config.yaml.
is_protected_branch() {
  local branch="$1"
  local config_file="${2:-./config.yaml}"
  local extra_branches="${3:-}"

  local global_protected task_protected all_protected
  global_protected=$(yq e '.protected_branches[]' "$config_file" 2>/dev/null || echo -e "main\nmaster\ndevelop")
  task_protected="$extra_branches"
  all_protected=$(printf '%s\n%s\n' "$global_protected" "$task_protected" | awk 'NF' | sort -u)
  echo "$all_protected" | grep -qx "$branch"
}

# macOS timeout fallback (GNU timeout not available by default)
if ! command -v timeout >/dev/null 2>&1; then
  timeout() {
    # Parse timeout flags to extract duration
    local duration=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --signal=*|--kill-after=*) shift ;;
        -*)                        shift ;;
        *)
          if [[ -z "$duration" ]]; then
            duration="$1"
            shift
            break
          fi
          ;;
      esac
    done
    # Convert duration like "30m" to seconds
    local secs
    if [[ "$duration" =~ ^([0-9]+)m$ ]]; then
      secs=$(( ${BASH_REMATCH[1]} * 60 ))
    else
      secs="$duration"
    fi
    perl -e "alarm $secs; exec @ARGV" -- "$@"
  }
fi
