#!/usr/bin/env bats
# Tests for lib/model-router.sh and lib/tool-router.sh

load test_helper

setup() {
  export TEST_TEMP_DIR
  TEST_TEMP_DIR="$(mktemp -d)"
}

teardown() {
  rm -rf "$TEST_TEMP_DIR"
}

# ── Model routing ─────────────────────────────────────────────

@test "plan phase always routes to opus (complex model)" {
  run route_model "implementation" "low" "" "plan"
  [ "$output" = "claude-opus-4-20250514" ]

  run route_model "research" "medium" "" "plan"
  [ "$output" = "claude-opus-4-20250514" ]

  run route_model "test" "high" "" "plan"
  [ "$output" = "claude-opus-4-20250514" ]
}

@test "review phase always routes to sonnet (default model)" {
  run route_model "implementation" "high" "" "review"
  [ "$output" = "claude-sonnet-4-20250514" ]

  run route_model "refactor" "high" "" "review"
  [ "$output" = "claude-sonnet-4-20250514" ]

  run route_model "test" "low" "" "review"
  [ "$output" = "claude-sonnet-4-20250514" ]
}

@test "high complexity test routes to opus in implement phase" {
  run route_model "test" "high" "" "implement"
  [ "$output" = "claude-opus-4-20250514" ]
}

@test "high complexity refactor routes to opus in implement phase" {
  run route_model "refactor" "high" "" "implement"
  [ "$output" = "claude-opus-4-20250514" ]
}

@test "low complexity test routes to sonnet in implement phase" {
  run route_model "test" "low" "" "implement"
  [ "$output" = "claude-sonnet-4-20250514" ]
}

@test "medium complexity refactor routes to sonnet in implement phase" {
  run route_model "refactor" "medium" "" "implement"
  [ "$output" = "claude-sonnet-4-20250514" ]
}

@test "implementation type always routes to sonnet regardless of complexity" {
  run route_model "implementation" "high" "" "implement"
  [ "$output" = "claude-sonnet-4-20250514" ]

  run route_model "implementation" "low" "" "implement"
  [ "$output" = "claude-sonnet-4-20250514" ]
}

@test "research type routes to sonnet in implement phase" {
  run route_model "research" "high" "" "implement"
  [ "$output" = "claude-sonnet-4-20250514" ]
}

@test "unknown task type defaults to sonnet" {
  run route_model "unknown-type" "high" "" "implement"
  [ "$output" = "claude-sonnet-4-20250514" ]
}

# ── Tool routing ──────────────────────────────────────────────

@test "research type gets read-only tools" {
  run route_tools "research"
  [[ "$output" == *"Read"* ]]
  [[ "$output" == *"Grep"* ]]
  [[ "$output" == *"Glob"* ]]
  [[ "$output" == *"curl"* ]]
  # Must NOT include Write or Edit
  [[ "$output" != *"Write"* ]]
  [[ "$output" != *"Edit"* ]]
}

@test "implementation type gets read-write tools" {
  run route_tools "implementation"
  [[ "$output" == *"Read"* ]]
  [[ "$output" == *"Write"* ]]
  [[ "$output" == *"Edit"* ]]
  [[ "$output" == *"git add"* ]]
  [[ "$output" == *"git commit"* ]]
}

@test "test type gets test runner tools" {
  run route_tools "test"
  [[ "$output" == *"npm test"* ]]
  [[ "$output" == *"pytest"* ]]
  [[ "$output" == *"go test"* ]]
}

@test "refactor type gets same tools as implementation" {
  local impl_tools
  impl_tools=$(route_tools "implementation")
  local refactor_tools
  refactor_tools=$(route_tools "refactor")
  [ "$impl_tools" = "$refactor_tools" ]
}

@test "custom tools override defaults" {
  run route_tools "research" "Read,Write,CustomTool"
  [ "$output" = "Read,Write,CustomTool" ]
}

@test "empty custom tools string uses defaults" {
  run route_tools "research" ""
  [[ "$output" == *"Read"* ]]
  [[ "$output" == *"Grep"* ]]
}

@test "unknown task type gets basic git tools" {
  run route_tools "some-unknown-type"
  [[ "$output" == *"Read"* ]]
  [[ "$output" == *"Write"* ]]
  [[ "$output" == *"git add"* ]]
}
