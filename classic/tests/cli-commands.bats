#!/usr/bin/env bats
# Tests for CLI enable/disable/sessions/version commands

load test_helper

setup() {
  export TEST_TEMP_DIR
  TEST_TEMP_DIR="$(mktemp -d)"
}

teardown() {
  rm -rf "$TEST_TEMP_DIR"
}

# ── --version ────────────────────────────────────────────────

@test "--version output matches VERSION file" {
  run "$PROJECT_ROOT/nightcrew.sh" --version
  [ "$status" -eq 0 ]
  local expected
  expected=$(cat "$PROJECT_ROOT/VERSION" | tr -d '[:space:]')
  [[ "$output" == *"$expected"* ]]
}

# ── enable/disable ───────────────────────────────────────────

@test "enable sets enabled=true on a task" {
  cat > "$TEST_TEMP_DIR/tasks.yaml" <<'EOF'
tasks:
  - id: task-1
    title: "Test task"
    branch: "feat/test"
    type: implementation
    prompt: "Do it"
    enabled: false
EOF

  run "$PROJECT_ROOT/nightcrew.sh" enable task-1 --tasks "$TEST_TEMP_DIR/tasks.yaml"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Enabled: task-1"* ]]

  local val
  val=$(yq e '.tasks[0].enabled' "$TEST_TEMP_DIR/tasks.yaml")
  [ "$val" = "true" ]
}

@test "disable sets enabled=false on a task" {
  cat > "$TEST_TEMP_DIR/tasks.yaml" <<'EOF'
tasks:
  - id: task-1
    title: "Test task"
    branch: "feat/test"
    type: implementation
    prompt: "Do it"
    enabled: true
EOF

  run "$PROJECT_ROOT/nightcrew.sh" disable task-1 --tasks "$TEST_TEMP_DIR/tasks.yaml"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Disabled: task-1"* ]]

  local val
  val=$(yq e '.tasks[0].enabled' "$TEST_TEMP_DIR/tasks.yaml")
  [ "$val" = "false" ]
}

@test "enable nonexistent task exits with error" {
  cat > "$TEST_TEMP_DIR/tasks.yaml" <<'EOF'
tasks:
  - id: task-1
    title: "Test task"
    branch: "feat/test"
    type: implementation
    prompt: "Do it"
EOF

  run "$PROJECT_ROOT/nightcrew.sh" enable nonexistent --tasks "$TEST_TEMP_DIR/tasks.yaml"
  [ "$status" -ne 0 ]
  [[ "$output" == *"not found"* ]]
}

@test "disable nonexistent task exits with error" {
  cat > "$TEST_TEMP_DIR/tasks.yaml" <<'EOF'
tasks:
  - id: task-1
    title: "Test task"
    branch: "feat/test"
    type: implementation
    prompt: "Do it"
EOF

  run "$PROJECT_ROOT/nightcrew.sh" disable nonexistent --tasks "$TEST_TEMP_DIR/tasks.yaml"
  [ "$status" -ne 0 ]
  [[ "$output" == *"not found"* ]]
}

# ── sessions ─────────────────────────────────────────────────

@test "sessions with no sessions directory shows empty message" {
  run "$PROJECT_ROOT/nightcrew.sh" sessions
  [ "$status" -eq 0 ]
  [[ "$output" == *"No sessions"* ]]
}

@test "sessions lists archived sessions" {
  # Create a fake session
  local sid="2026-04-05T120000Z"
  mkdir -p "$PROJECT_ROOT/state/sessions/$sid/logs"
  echo '{"session_started":"2026-04-05T12:00:00Z","tasks":{"t1":{"status":"complete"}},"total_cost_cents":42}' > "$PROJECT_ROOT/state/sessions/$sid/progress.json"

  run "$PROJECT_ROOT/nightcrew.sh" sessions
  [ "$status" -eq 0 ]
  [[ "$output" == *"$sid"* ]]

  # Cleanup
  rm -rf "$PROJECT_ROOT/state/sessions/$sid"
}

@test "sessions --json returns valid JSON" {
  # Create a fake session
  local sid="2026-04-05T130000Z"
  mkdir -p "$PROJECT_ROOT/state/sessions/$sid/logs"
  echo '{"session_started":"2026-04-05T13:00:00Z","tasks":{"t1":{"status":"complete"}},"total_cost_cents":10}' > "$PROJECT_ROOT/state/sessions/$sid/progress.json"

  run "$PROJECT_ROOT/nightcrew.sh" sessions --json
  [ "$status" -eq 0 ]
  # Validate JSON
  echo "$output" | jq -e '.sessions' >/dev/null
  echo "$output" | jq -e '.sessions[0].id' >/dev/null

  # Cleanup
  rm -rf "$PROJECT_ROOT/state/sessions/$sid"
}
