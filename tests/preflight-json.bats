#!/usr/bin/env bats
# Tests for JSON preflight validation parity

load test_helper

source "$PROJECT_ROOT/lib/run.sh"

setup() {
  export TEST_TEMP_DIR
  TEST_TEMP_DIR="$(mktemp -d)"
}

teardown() {
  rm -rf "$TEST_TEMP_DIR"
}

# ── JSON preflight validates required fields ─────────────────

@test "validate_task_fields catches missing required field" {
  cat > "$TEST_TEMP_DIR/tasks.json" <<'EOF'
{"tasks":[{"id":"t1","title":"Test","branch":"feat/test","type":"implementation"}]}
EOF
  run validate_task_fields "$TEST_TEMP_DIR/tasks.json"
  [ "$status" -ne 0 ]
  [[ "$output" == *"missing required field"* ]]
  [[ "$output" == *"prompt"* ]]
}

# ── JSON preflight catches invalid type enum ─────────────────

@test "validate_task_fields catches invalid type enum" {
  cat > "$TEST_TEMP_DIR/tasks.json" <<'EOF'
{"tasks":[{"id":"t1","title":"Test","branch":"feat/test","type":"invalid-type","prompt":"Do it"}]}
EOF
  run validate_task_fields "$TEST_TEMP_DIR/tasks.json"
  [ "$status" -ne 0 ]
  [[ "$output" == *"invalid type"* ]]
}

# ── JSON preflight validates project_path ────────────────────

@test "validate_task_fields catches non-absolute project_path" {
  cat > "$TEST_TEMP_DIR/tasks.json" <<'EOF'
{"tasks":[{"id":"t1","title":"Test","branch":"feat/test","type":"implementation","prompt":"Do it","project_path":"relative/path"}]}
EOF
  run validate_task_fields "$TEST_TEMP_DIR/tasks.json"
  [ "$status" -ne 0 ]
  [[ "$output" == *"not absolute"* ]]
}
