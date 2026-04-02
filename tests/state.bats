#!/usr/bin/env bats
# Tests for lib/state.sh — state machine and progress tracking

load test_helper

setup() {
  export TEST_TEMP_DIR
  TEST_TEMP_DIR="$(mktemp -d)"
}

teardown() {
  rm -rf "$TEST_TEMP_DIR"
}

# ── init_state ────────────────────────────────────────────────

@test "init_state creates state directory and progress.json" {
  init_state "$TEST_TEMP_DIR"

  [ -d "$TEST_TEMP_DIR/state" ]
  [ -f "$TEST_TEMP_DIR/state/progress.json" ]
}

@test "init_state produces valid JSON with expected keys" {
  init_state "$TEST_TEMP_DIR"

  run jq -e '.session_started' "$STATE_FILE"
  [ "$status" -eq 0 ]

  run jq -e '.tasks' "$STATE_FILE"
  [ "$status" -eq 0 ]

  run jq -e '.total_cost_cents' "$STATE_FILE"
  [ "$status" -eq 0 ]
}

@test "init_state does not overwrite existing progress.json" {
  init_state "$TEST_TEMP_DIR"
  local original_ts
  original_ts=$(jq -r '.session_started' "$STATE_FILE")

  sleep 1
  init_state "$TEST_TEMP_DIR"
  local second_ts
  second_ts=$(jq -r '.session_started' "$STATE_FILE")

  [ "$original_ts" = "$second_ts" ]
}

# ── mark_task transitions ────────────────────────────────────

@test "mark_task in_progress: pending -> in_progress" {
  init_state "$TEST_TEMP_DIR"

  local status_before
  status_before=$(get_task_status "task-1")
  [ "$status_before" = "pending" ]

  mark_task "in_progress" "task-1"

  local status_after
  status_after=$(get_task_status "task-1")
  [ "$status_after" = "in_progress" ]

  run jq -r '.tasks["task-1"].started_at' "$STATE_FILE"
  [ "$status" -eq 0 ]
  [ "$output" != "null" ]
}

@test "mark_task complete: in_progress -> complete with pr_url" {
  init_state "$TEST_TEMP_DIR"
  mark_task "in_progress" "task-1"
  mark_task "complete" "task-1" "https://github.com/org/repo/pull/42"

  local task_status
  task_status=$(get_task_status "task-1")
  [ "$task_status" = "complete" ]

  run jq -r '.tasks["task-1"].pr_url' "$STATE_FILE"
  [ "$output" = "https://github.com/org/repo/pull/42" ]

  run jq -r '.tasks["task-1"].completed_at' "$STATE_FILE"
  [ "$output" != "null" ]
}

@test "mark_task failed: in_progress -> failed with reason" {
  init_state "$TEST_TEMP_DIR"
  mark_task "in_progress" "task-1"
  mark_task "failed" "task-1" "test suite broken"

  local task_status
  task_status=$(get_task_status "task-1")
  [ "$task_status" = "failed" ]

  run jq -r '.tasks["task-1"].reason' "$STATE_FILE"
  [ "$output" = "test suite broken" ]
}

@test "mark_task paused: in_progress -> paused" {
  init_state "$TEST_TEMP_DIR"
  mark_task "in_progress" "task-1"
  mark_task "paused" "task-1"

  local task_status
  task_status=$(get_task_status "task-1")
  [ "$task_status" = "paused" ]

  run jq -r '.tasks["task-1"].paused_at' "$STATE_FILE"
  [ "$output" != "null" ]
}

@test "mark_task blocked: sets blocked_by field" {
  init_state "$TEST_TEMP_DIR"
  mark_task "blocked" "task-2" "task-1"

  local task_status
  task_status=$(get_task_status "task-2")
  [ "$task_status" = "blocked" ]

  run jq -r '.tasks["task-2"].blocked_by' "$STATE_FILE"
  [ "$output" = "task-1" ]
}

# ── set_task_field ────────────────────────────────────────────

@test "set_task_field updates a custom field" {
  init_state "$TEST_TEMP_DIR"
  mark_task "in_progress" "task-1"

  set_task_field "task-1" "model" "claude-opus-4-20250514"

  run jq -r '.tasks["task-1"].model' "$STATE_FILE"
  [ "$output" = "claude-opus-4-20250514" ]
}

@test "set_task_field overwrites existing value" {
  init_state "$TEST_TEMP_DIR"
  mark_task "in_progress" "task-1"
  set_task_field "task-1" "log_file" "/tmp/old.log"
  set_task_field "task-1" "log_file" "/tmp/new.log"

  run jq -r '.tasks["task-1"].log_file' "$STATE_FILE"
  [ "$output" = "/tmp/new.log" ]
}

# ── add_cost ──────────────────────────────────────────────────

@test "add_cost accumulates total_cost_cents" {
  init_state "$TEST_TEMP_DIR"

  add_cost 10
  add_cost 25
  add_cost 5

  local total
  total=$(get_total_cost)
  [ "$total" -eq 40 ]
}

@test "add_cost starts from zero" {
  init_state "$TEST_TEMP_DIR"

  local total
  total=$(get_total_cost)
  [ "$total" -eq 0 ]
}
