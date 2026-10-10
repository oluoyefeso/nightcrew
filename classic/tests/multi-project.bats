#!/usr/bin/env bats
# Tests for multi-project support (project_path field)

load test_helper

# Source run.sh for validate_task_fields
source "$PROJECT_ROOT/lib/run.sh"

setup() {
  export TEST_TEMP_DIR
  TEST_TEMP_DIR="$(mktemp -d)"
}

teardown() {
  rm -rf "$TEST_TEMP_DIR"
}

# ── validate_task_fields: project_path validation ────────────

@test "validate_task_fields accepts task without project_path" {
  cat > "$TEST_TEMP_DIR/tasks.json" <<'EOF'
{"tasks":[{"id":"t1","title":"Test","branch":"feat/test","type":"implementation","prompt":"Do it"}]}
EOF
  run validate_task_fields "$TEST_TEMP_DIR/tasks.json"
  [ "$status" -eq 0 ]
}

@test "validate_task_fields accepts task with absolute project_path" {
  # Create a temp git repo for the path to point to
  mkdir -p "$TEST_TEMP_DIR/fake-repo"
  git -C "$TEST_TEMP_DIR/fake-repo" init --quiet

  cat > "$TEST_TEMP_DIR/tasks.json" <<EOF
{"tasks":[{"id":"t1","title":"Test","branch":"feat/test","type":"implementation","prompt":"Do it","project_path":"$TEST_TEMP_DIR/fake-repo"}]}
EOF
  run validate_task_fields "$TEST_TEMP_DIR/tasks.json"
  [ "$status" -eq 0 ]
}

@test "validate_task_fields rejects non-absolute project_path" {
  cat > "$TEST_TEMP_DIR/tasks.json" <<'EOF'
{"tasks":[{"id":"t1","title":"Test","branch":"feat/test","type":"implementation","prompt":"Do it","project_path":"relative/path"}]}
EOF
  run validate_task_fields "$TEST_TEMP_DIR/tasks.json"
  [ "$status" -ne 0 ]
  [[ "$output" == *"not absolute"* ]]
}

@test "validate_task_fields rejects project_path that is not a git repo" {
  mkdir -p "$TEST_TEMP_DIR/not-a-repo"

  cat > "$TEST_TEMP_DIR/tasks.json" <<EOF
{"tasks":[{"id":"t1","title":"Test","branch":"feat/test","type":"implementation","prompt":"Do it","project_path":"$TEST_TEMP_DIR/not-a-repo"}]}
EOF
  run validate_task_fields "$TEST_TEMP_DIR/tasks.json"
  [ "$status" -ne 0 ]
  [[ "$output" == *"not a git repo"* ]]
}

@test "validate_task_fields rejects project_path that does not exist" {
  cat > "$TEST_TEMP_DIR/tasks.json" <<'EOF'
{"tasks":[{"id":"t1","title":"Test","branch":"feat/test","type":"implementation","prompt":"Do it","project_path":"/nonexistent/path/nowhere"}]}
EOF
  run validate_task_fields "$TEST_TEMP_DIR/tasks.json"
  [ "$status" -ne 0 ]
  [[ "$output" == *"not a git repo"* ]]
}

@test "validate_task_fields validates multiple tasks with mixed project_paths" {
  mkdir -p "$TEST_TEMP_DIR/repo-a"
  git -C "$TEST_TEMP_DIR/repo-a" init --quiet

  cat > "$TEST_TEMP_DIR/tasks.json" <<EOF
{"tasks":[
  {"id":"t1","title":"Test A","branch":"feat/a","type":"implementation","prompt":"A","project_path":"$TEST_TEMP_DIR/repo-a"},
  {"id":"t2","title":"Test B","branch":"feat/b","type":"implementation","prompt":"B"}
]}
EOF
  run validate_task_fields "$TEST_TEMP_DIR/tasks.json"
  [ "$status" -eq 0 ]
}
