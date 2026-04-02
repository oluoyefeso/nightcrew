#!/usr/bin/env bats
# Tests for lib/git-ops.sh — worktree setup, commit, push

load test_helper

# Source git-ops explicitly (test_helper doesn't source it)
source "$PROJECT_ROOT/lib/git-ops.sh"

setup() {
  export TEST_TEMP_DIR
  TEST_TEMP_DIR="$(mktemp -d)"

  # Create a minimal git repo to use as the "target repo"
  git -C "$TEST_TEMP_DIR" init -b main --quiet
  git -C "$TEST_TEMP_DIR" commit --allow-empty -m "initial" --quiet
}

teardown() {
  # Clean up worktrees before removing the directory
  git -C "$TEST_TEMP_DIR" worktree prune 2>/dev/null || true
  rm -rf "$TEST_TEMP_DIR"
}

# ── setup_worktree success ───────────────────────────────────

@test "setup_worktree returns clean single-line path on success" {
  run setup_worktree "$TEST_TEMP_DIR" "test-task" "feat/test-branch" "main"
  [ "$status" -eq 0 ]
  # Output should be exactly one line
  local line_count
  line_count=$(echo "$output" | wc -l | tr -d ' ')
  [ "$line_count" -eq 1 ]
  # Output should be the expected path
  [[ "$output" == "$TEST_TEMP_DIR/.worktrees/test-task" ]]
  # Directory should exist
  [ -d "$output" ]
}

# ── setup_worktree failure: bad base branch ──────────────────

@test "setup_worktree returns non-zero when git worktree add fails" {
  # Use a non-existent base branch to trigger failure
  run setup_worktree "$TEST_TEMP_DIR" "test-task" "feat/new" "nonexistent-base-branch"
  [ "$status" -ne 0 ]
  [[ "$output" == *"ERROR"* ]]
}

# ── setup_worktree failure: directory not created ────────────

@test "setup_worktree returns non-zero when target directory missing after git" {
  # Use a repo path that doesn't exist to trigger mkdir + git failure
  run setup_worktree "/nonexistent/repo/path" "test-task" "feat/test" "main"
  [ "$status" -ne 0 ]
}

# ── setup_worktree resume: stale directory ───────────────────

@test "setup_worktree detects and recreates stale worktree directory" {
  local worktree_path="$TEST_TEMP_DIR/.worktrees/stale-task"

  # Create a stale directory (not a valid git worktree)
  mkdir -p "$worktree_path"
  echo "stale content" > "$worktree_path/leftover.txt"

  # setup_worktree should detect it's stale, remove it, and recreate
  run setup_worktree "$TEST_TEMP_DIR" "stale-task" "feat/stale-recovery" "main"
  [ "$status" -eq 0 ]
  [ -d "$worktree_path" ]
  # The stale file should be gone (directory was recreated)
  [ ! -f "$worktree_path/leftover.txt" ]
  # Should be a valid git worktree now
  git -C "$worktree_path" rev-parse --is-inside-work-tree >/dev/null 2>&1
}
