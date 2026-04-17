#!/usr/bin/env bats
# Tests for is_protected_branch() union logic (lib/00-common.sh)

load test_helper

# ── Case 1: Global list only, 2-arg form ────────────────────────────────────

@test "is_protected_branch: 2-arg form matches branch in global list" {
  local config="$TEST_TEMP_DIR/config.yaml"
  printf 'protected_branches:\n  - main\n  - production\n' > "$config"

  run is_protected_branch "main" "$config"
  [ "$status" -eq 0 ]
}

@test "is_protected_branch: 2-arg form matches second branch in global list" {
  local config="$TEST_TEMP_DIR/config.yaml"
  printf 'protected_branches:\n  - main\n  - production\n' > "$config"

  run is_protected_branch "production" "$config"
  [ "$status" -eq 0 ]
}

@test "is_protected_branch: 2-arg form returns non-zero for non-protected branch" {
  local config="$TEST_TEMP_DIR/config.yaml"
  printf 'protected_branches:\n  - main\n  - production\n' > "$config"

  run is_protected_branch "feature/foo" "$config"
  [ "$status" -ne 0 ]
}

# ── Case 2: Per-task branch only, 3-arg form ────────────────────────────────

@test "is_protected_branch: 3-arg form detects branch from task-only extra list" {
  local config="$TEST_TEMP_DIR/config.yaml"
  printf 'protected_branches:\n  - main\n' > "$config"

  run is_protected_branch "release" "$config" "release"
  [ "$status" -eq 0 ]
}

@test "is_protected_branch: 3-arg form returns non-zero when branch not in either list" {
  local config="$TEST_TEMP_DIR/config.yaml"
  printf 'protected_branches:\n  - main\n' > "$config"

  run is_protected_branch "feature/foo" "$config" "release"
  [ "$status" -ne 0 ]
}

# ── Case 3: Union — both lists contribute ───────────────────────────────────

@test "is_protected_branch: union — global-list hit when extra present" {
  local config="$TEST_TEMP_DIR/config.yaml"
  printf 'protected_branches:\n  - main\n' > "$config"

  run is_protected_branch "main" "$config" "release"
  [ "$status" -eq 0 ]
}

@test "is_protected_branch: union — task-list hit when global present" {
  local config="$TEST_TEMP_DIR/config.yaml"
  printf 'protected_branches:\n  - main\n' > "$config"

  run is_protected_branch "release" "$config" "release"
  [ "$status" -eq 0 ]
}

@test "is_protected_branch: union — non-member returns non-zero" {
  local config="$TEST_TEMP_DIR/config.yaml"
  printf 'protected_branches:\n  - main\n' > "$config"

  run is_protected_branch "other" "$config" "release"
  [ "$status" -ne 0 ]
}

# ── Case 4: De-dup across lists, no shell errors ────────────────────────────

@test "is_protected_branch: de-dup — duplicate entry across lists causes no errors" {
  local config="$TEST_TEMP_DIR/config.yaml"
  printf 'protected_branches:\n  - main\n' > "$config"
  local extra
  extra=$'main\nrelease'

  run is_protected_branch "main" "$config" "$extra"
  [ "$status" -eq 0 ]
  [[ "$output" != *"command not found"* ]]
  [[ "$output" != *"bad substitution"* ]]
}

@test "is_protected_branch: de-dup — second branch in extra also protected" {
  local config="$TEST_TEMP_DIR/config.yaml"
  printf 'protected_branches:\n  - main\n' > "$config"
  local extra
  extra=$'main\nrelease'

  run is_protected_branch "release" "$config" "$extra"
  [ "$status" -eq 0 ]
}

# ── Case 5: Empty extra equivalence with 2-arg ──────────────────────────────

@test "is_protected_branch: empty extra arg behaves identically to 2-arg form — match" {
  local config="$TEST_TEMP_DIR/config.yaml"
  printf 'protected_branches:\n  - main\n' > "$config"

  run is_protected_branch "main" "$config" ""
  [ "$status" -eq 0 ]
}

@test "is_protected_branch: empty extra arg behaves identically to 2-arg form — no match" {
  local config="$TEST_TEMP_DIR/config.yaml"
  printf 'protected_branches:\n  - main\n' > "$config"

  run is_protected_branch "feature/foo" "$config" ""
  [ "$status" -ne 0 ]
}

# ── Case 6: Task-level list fetched via yq from tasks.yaml ──────────────────

@test "is_protected_branch: task-level protected_branches fetched from tasks.yaml via yq" {
  local config="$TEST_TEMP_DIR/config.yaml"
  local tasks="$TEST_TEMP_DIR/tasks.yaml"

  printf 'protected_branches:\n  - main\n' > "$config"
  cat > "$tasks" <<'YAML'
tasks:
  - id: test-task
    title: "Test task"
    branch: feat/something
    type: implementation
    prompt: "Do something"
    protected_branches:
      - release
YAML

  local extra
  extra=$(yq e '.tasks[0].protected_branches[]?' "$tasks" 2>/dev/null)

  run is_protected_branch "release" "$config" "$extra"
  [ "$status" -eq 0 ]

  run is_protected_branch "main" "$config" "$extra"
  [ "$status" -eq 0 ]

  run is_protected_branch "other" "$config" "$extra"
  [ "$status" -ne 0 ]
}
