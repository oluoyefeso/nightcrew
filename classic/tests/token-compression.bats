#!/usr/bin/env bats
# Tests for token compression: compress_plan_for_impl, benchmark

load test_helper

# Source modules not included in test_helper
source "$PROJECT_ROOT/lib/prompt-builder.sh"
source "$PROJECT_ROOT/lib/benchmark.sh"

setup() {
  export TEST_TEMP_DIR
  TEST_TEMP_DIR="$(mktemp -d)"
}

teardown() {
  rm -rf "$TEST_TEMP_DIR"
}

# ── compress_plan_for_impl ───────────────────────────────

@test "compress_plan_for_impl keeps implementation-relevant sections" {
  cat > "$TEST_TEMP_DIR/plan.md" <<'EOF'
# Implementation Plan: test-task

## Scope Decision
Keep this section.

## Architecture Decisions
1. Use existing patterns.

## Implementation Steps
1. Edit file.sh
2. Add function.

## Test Plan
Write tests for the function.

## Failure Modes
Handle empty input.

## NOT In Scope
Future improvements.

## Decisions Log
Chose approach A over B.
EOF

  run compress_plan_for_impl "$TEST_TEMP_DIR/plan.md"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Scope Decision"* ]]
  [[ "$output" == *"Architecture Decisions"* ]]
  [[ "$output" == *"Implementation Steps"* ]]
  [[ "$output" == *"Test Plan"* ]]
  [[ "$output" == *"Failure Mode"* ]]
  [[ "$output" != *"NOT In Scope"* ]]
  [[ "$output" != *"Decisions Log"* ]]
}

@test "compress_plan_for_impl passes through unchanged when no expected headings" {
  cat > "$TEST_TEMP_DIR/plan.md" <<'EOF'
Some random plan content without standard headings.
Just a paragraph of text.
EOF

  run compress_plan_for_impl "$TEST_TEMP_DIR/plan.md"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Some random plan content"* ]]
}

@test "compress_plan_for_impl handles empty file" {
  touch "$TEST_TEMP_DIR/plan.md"
  run compress_plan_for_impl "$TEST_TEMP_DIR/plan.md"
  [ "$status" -eq 0 ]
}

@test "compress_plan_for_impl handles nonexistent file" {
  run compress_plan_for_impl "/nonexistent/plan.md"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "compress_plan_for_impl preserves nested subheadings within kept sections" {
  cat > "$TEST_TEMP_DIR/plan.md" <<'EOF'
## Implementation Steps

### Step 1: Schema changes
Edit schema.json.

### Step 2: Logic changes
Edit run.sh.

## NOT In Scope
Deferred work.
EOF

  run compress_plan_for_impl "$TEST_TEMP_DIR/plan.md"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Step 1: Schema changes"* ]]
  [[ "$output" == *"Step 2: Logic changes"* ]]
  [[ "$output" != *"NOT In Scope"* ]]
}

@test "compress_plan_for_impl preserves ASCII diagrams within kept sections" {
  cat > "$TEST_TEMP_DIR/plan.md" <<'EOF'
## Test Plan

```
CODE PATH COVERAGE
===========================
[+] lib/run.sh
    |
    +-- function()
        +-- [GAP] edge case
```

## NOT In Scope
Nothing here.
EOF

  run compress_plan_for_impl "$TEST_TEMP_DIR/plan.md"
  [ "$status" -eq 0 ]
  [[ "$output" == *"CODE PATH COVERAGE"* ]]
  [[ "$output" == *"[GAP] edge case"* ]]
  [[ "$output" != *"NOT In Scope"* ]]
}

# ── nightcrew_benchmark ──────────────────────────────────

@test "benchmark produces output for two valid sessions" {
  mkdir -p "$TEST_TEMP_DIR/state/sessions/session-a"
  mkdir -p "$TEST_TEMP_DIR/state/sessions/session-b"

  cat > "$TEST_TEMP_DIR/state/sessions/session-a/progress.json" <<'EOF'
{
  "tasks": {
    "task-1": {
      "status": "complete",
      "plan_in_tokens": "1000",
      "plan_out_tokens": "500",
      "impl_in_tokens": "3000",
      "impl_out_tokens": "2000",
      "review_in_tokens": "800",
      "review_out_tokens": "400"
    }
  }
}
EOF

  cat > "$TEST_TEMP_DIR/state/sessions/session-b/progress.json" <<'EOF'
{
  "tasks": {
    "task-1": {
      "status": "complete",
      "plan_in_tokens": "1000",
      "plan_out_tokens": "500",
      "impl_in_tokens": "2000",
      "impl_out_tokens": "1200",
      "review_in_tokens": "600",
      "review_out_tokens": "250"
    }
  }
}
EOF

  run nightcrew_benchmark "session-a" "session-b" "$TEST_TEMP_DIR"
  [ "$status" -eq 0 ]
  [[ "$output" == *"TOKEN BENCHMARK"* ]]
  [[ "$output" == *"task-1"* ]]
  [[ "$output" == *"SESSION TOTAL"* ]]
  [[ "$output" == *"ESTIMATED COST"* ]]
}

@test "benchmark errors on missing session" {
  mkdir -p "$TEST_TEMP_DIR/state/sessions/session-a"
  cat > "$TEST_TEMP_DIR/state/sessions/session-a/progress.json" <<'EOF'
{"tasks":{}}
EOF

  run nightcrew_benchmark "session-a" "nonexistent" "$TEST_TEMP_DIR"
  [ "$status" -eq 1 ]
  [[ "$output" == *"not found"* ]]
}

@test "benchmark handles tasks with missing per-phase fields" {
  mkdir -p "$TEST_TEMP_DIR/state/sessions/session-a"
  mkdir -p "$TEST_TEMP_DIR/state/sessions/session-b"

  cat > "$TEST_TEMP_DIR/state/sessions/session-a/progress.json" <<'EOF'
{"tasks":{"task-1":{"status":"complete"}}}
EOF
  cat > "$TEST_TEMP_DIR/state/sessions/session-b/progress.json" <<'EOF'
{"tasks":{"task-1":{"status":"complete"}}}
EOF

  run nightcrew_benchmark "session-a" "session-b" "$TEST_TEMP_DIR"
  [ "$status" -eq 0 ]
  [[ "$output" == *"TOKEN BENCHMARK"* ]]
}

@test "benchmark shows task outcome changes" {
  mkdir -p "$TEST_TEMP_DIR/state/sessions/session-a"
  mkdir -p "$TEST_TEMP_DIR/state/sessions/session-b"

  cat > "$TEST_TEMP_DIR/state/sessions/session-a/progress.json" <<'EOF'
{"tasks":{"task-1":{"status":"failed","plan_in_tokens":"100","plan_out_tokens":"50"}}}
EOF
  cat > "$TEST_TEMP_DIR/state/sessions/session-b/progress.json" <<'EOF'
{"tasks":{"task-1":{"status":"complete","plan_in_tokens":"100","plan_out_tokens":"50"}}}
EOF

  run nightcrew_benchmark "session-a" "session-b" "$TEST_TEMP_DIR"
  [ "$status" -eq 0 ]
  [[ "$output" == *"CHANGED"* ]]
}
