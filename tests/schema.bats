#!/usr/bin/env bats
# Tests for schema validation in preflight_validate (lib/run.sh)
#
# We test the schema-checking portion by calling the inner logic directly:
# convert YAML to JSON, then validate required fields and type enums.

load test_helper

setup() {
  export TEST_TEMP_DIR
  TEST_TEMP_DIR="$(mktemp -d)"
  export NIGHTCREW_DIR="$PROJECT_ROOT"
}

teardown() {
  rm -rf "$TEST_TEMP_DIR"
}

# Helper: run just the schema validation portion of preflight.
# Mirrors the logic inside preflight_validate without the git/template/dep checks.
validate_schema() {
  local tasks_file="$1"
  local schema_file="$NIGHTCREW_DIR/schemas/task.schema.json"

  local json_tmp
  json_tmp=$(mktemp /tmp/nightcrew-validate-XXXXXXXX.json)
  if ! yq e -o=json '.' "$tasks_file" > "$json_tmp" 2>/dev/null; then
    echo "ERROR: tasks.yaml is not valid YAML"
    rm -f "$json_tmp"
    return 1
  fi

  local task_count
  task_count=$(jq '.tasks | length' "$json_tmp")
  local schema_errors=0

  for i in $(seq 0 $((task_count - 1))); do
    for field in id title branch type prompt; do
      local val
      val=$(jq -r ".tasks[$i].$field // empty" "$json_tmp")
      if [[ -z "$val" ]]; then
        echo "ERROR: Task $i missing required field '$field'"
        ((schema_errors++))
      fi
    done
    # Validate type enum
    local task_type
    task_type=$(jq -r ".tasks[$i].type // empty" "$json_tmp")
    if [[ -n "$task_type" ]] && ! echo "$task_type" | grep -qE '^(research|implementation|refactor|test)$'; then
      echo "ERROR: Task $i has invalid type '$task_type'"
      ((schema_errors++))
    fi
    # Validate complexity enum
    local complexity
    complexity=$(jq -r ".tasks[$i].complexity // empty" "$json_tmp")
    if [[ -n "$complexity" ]] && ! echo "$complexity" | grep -qE '^(low|medium|high)$'; then
      echo "ERROR: Task $i has invalid complexity '$complexity'"
      ((schema_errors++))
    fi
  done
  rm -f "$json_tmp"

  return $schema_errors
}

# ── Valid schema ──────────────────────────────────────────────

@test "valid tasks.yaml passes schema validation" {
  run validate_schema "$PROJECT_ROOT/tests/fixtures/tasks-valid.yaml"
  [ "$status" -eq 0 ]
}

# ── Missing required field ────────────────────────────────────

@test "task with invalid type field fails schema validation" {
  run validate_schema "$PROJECT_ROOT/tests/fixtures/tasks-invalid-type.yaml"
  [ "$status" -ne 0 ]
  [[ "$output" == *"invalid type"* ]]
}

# ── Missing required fields ───────────────────────────────────

@test "task missing required fields fails schema validation" {
  cat > "$TEST_TEMP_DIR/tasks-no-prompt.yaml" <<'EOF'
tasks:
  - id: task-1
    title: "Some task"
    branch: "task/some"
    type: implementation
EOF

  run validate_schema "$TEST_TEMP_DIR/tasks-no-prompt.yaml"
  [ "$status" -ne 0 ]
  [[ "$output" == *"missing required field"* ]]
}
