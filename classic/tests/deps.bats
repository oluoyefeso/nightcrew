#!/usr/bin/env bats
# Tests for validate_dependencies in lib/run.sh

load test_helper

setup() {
  export TEST_TEMP_DIR
  TEST_TEMP_DIR="$(mktemp -d)"
}

teardown() {
  rm -rf "$TEST_TEMP_DIR"
}

# ── Circular dependencies ────────────────────────────────────

@test "validate_dependencies catches circular deps" {
  run validate_dependencies "$PROJECT_ROOT/tests/fixtures/tasks-circular-deps.yaml"
  [ "$status" -ne 0 ]
}

# ── Missing dependency IDs ────────────────────────────────────

@test "validate_dependencies catches missing dep IDs" {
  run validate_dependencies "$PROJECT_ROOT/tests/fixtures/tasks-missing-dep.yaml"
  [ "$status" -ne 0 ]
}

# ── Valid dependencies ────────────────────────────────────────

@test "validate_dependencies passes for valid deps" {
  run validate_dependencies "$PROJECT_ROOT/tests/fixtures/tasks-valid.yaml"
  [ "$status" -eq 0 ]
}

# ── Empty tasks file ─────────────────────────────────────────

@test "validate_dependencies passes for empty tasks" {
  cat > "$TEST_TEMP_DIR/tasks-empty.yaml" <<'EOF'
tasks:
EOF

  run validate_dependencies "$TEST_TEMP_DIR/tasks-empty.yaml"
  [ "$status" -eq 0 ]
}

# ── Out-of-order dependencies ────────────────────────────────

@test "validate_dependencies warns on out-of-order deps" {
  # Create a tasks file where task-1 depends on task-2 but task-2 is listed second
  cat > "$TEST_TEMP_DIR/tasks-out-of-order.yaml" <<'EOF'
tasks:
  - id: task-1
    title: "First task"
    branch: "task/first"
    type: implementation
    prompt: "Do first thing"
    depends_on:
      - task-2
  - id: task-2
    title: "Second task"
    branch: "task/second"
    type: implementation
    prompt: "Do second thing"
EOF

  run validate_dependencies "$TEST_TEMP_DIR/tasks-out-of-order.yaml"
  # Should succeed (warnings are not errors) but produce a warning
  [ "$status" -eq 0 ]
  [[ "$output" == *"WARNING"* ]]
  [[ "$output" == *"listed after"* ]]
}
