#!/usr/bin/env bash
#
# Run lockfile functions for nightcrew
#

acquire_run_lock() {
  local lock_base="${NIGHTCREW_LOCK_DIR:-${NIGHTCREW_DIR:-$(pwd)}/state}"
  local lock_dir="$lock_base/.nightcrew.lock"

  # Ensure parent directory exists
  mkdir -p "$lock_base"

  # First attempt - try to acquire lock
  if mkdir "$lock_dir" 2>/dev/null; then
    echo "$$" > "$lock_dir/pid"
    return 0
  fi

  # Lock exists - check if holder is still alive
  local existing_pid=""
  if [[ -f "$lock_dir/pid" ]]; then
    existing_pid="$(cat "$lock_dir/pid" 2>/dev/null || echo "")"
  fi

  # If PID is empty or process is dead, treat as stale
  if [[ -z "$existing_pid" ]] || ! kill -0 "$existing_pid" 2>/dev/null; then
    echo "Stale lock from dead PID ${existing_pid:-unknown} — reclaiming." >&2
    rm -rf "$lock_dir"

    # Retry exactly once
    if mkdir "$lock_dir" 2>/dev/null; then
      echo "$$" > "$lock_dir/pid"
      return 0
    fi

    # If retry fails, re-read PID for error message
    if [[ -f "$lock_dir/pid" ]]; then
      existing_pid="$(cat "$lock_dir/pid" 2>/dev/null || echo "unknown")"
    else
      existing_pid="unknown"
    fi
  fi

  # Lock is held by a live process
  echo "Another nightcrew run is already in progress (PID $existing_pid). state/.nightcrew.lock is held." >&2
  exit 1
}

release_run_lock() {
  local lock_base="${NIGHTCREW_LOCK_DIR:-${NIGHTCREW_DIR:-$(pwd)}/state}"
  local lock_dir="$lock_base/.nightcrew.lock"

  rm -rf "$lock_dir" 2>/dev/null || true
  return 0
}