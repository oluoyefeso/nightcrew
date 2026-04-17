#!/usr/bin/env bats
# Tests for lib/tool-router.sh — comprehensive tool whitelist coverage

load test_helper

# ── Implementation whitelist ───────────────────────────────────

@test "implementation default whitelist includes all required tokens" {
  run route_tools "implementation"
  [[ "$output" == *"Read"* ]]
  [[ "$output" == *"Grep"* ]]
  [[ "$output" == *"Glob"* ]]
  [[ "$output" == *"Write"* ]]
  [[ "$output" == *"Edit"* ]]
  [[ "$output" == *"git add"* ]]
  [[ "$output" == *"git commit"* ]]
  [[ "$output" == *"git diff"* ]]
  [[ "$output" == *"git status"* ]]
  [[ "$output" == *"git log"* ]]
  [[ "$output" == *"git mv"* ]]
  [[ "$output" == *"git rm"* ]]
  [[ "$output" == *"npm test"* ]]
  [[ "$output" == *"npx"* ]]
  [[ "$output" == *"bun test"* ]]
  [[ "$output" == *"pytest"* ]]
  [[ "$output" == *"go test"* ]]
  [[ "$output" == *"bats"* ]]
  [[ "$output" == *"mkdir"* ]]
  [[ "$output" == *"test"* ]]
  [[ "$output" == *"grep"* ]]
  [[ "$output" == *"ls"* ]]
  [[ "$output" == *"cat"* ]]
  [[ "$output" == *"find"* ]]
  [[ "$output" == *"wc"* ]]
}

# ── Refactor equals implementation byte-for-byte ──────────────

@test "refactor default whitelist equals implementation byte-for-byte" {
  local impl
  impl=$(route_tools "implementation")
  local refactor
  refactor=$(route_tools "refactor")
  [ "$impl" = "$refactor" ]
}

# ── Test whitelist ─────────────────────────────────────────────

@test "test default whitelist includes expanded tokens" {
  run route_tools "test"
  [[ "$output" == *"Read"* ]]
  [[ "$output" == *"Grep"* ]]
  [[ "$output" == *"Glob"* ]]
  [[ "$output" == *"Write"* ]]
  [[ "$output" == *"Edit"* ]]
  [[ "$output" == *"git add"* ]]
  [[ "$output" == *"git commit"* ]]
  [[ "$output" == *"git diff"* ]]
  [[ "$output" == *"git status"* ]]
  [[ "$output" == *"git log"* ]]
  [[ "$output" == *"git mv"* ]]
  [[ "$output" == *"git rm"* ]]
  [[ "$output" == *"npm test"* ]]
  [[ "$output" == *"npx"* ]]
  [[ "$output" == *"bun test"* ]]
  [[ "$output" == *"pytest"* ]]
  [[ "$output" == *"go test"* ]]
  [[ "$output" == *"bats"* ]]
  [[ "$output" == *"mkdir"* ]]
  [[ "$output" == *"test"* ]]
  [[ "$output" == *"grep"* ]]
  [[ "$output" == *"ls"* ]]
  [[ "$output" == *"cat"* ]]
  [[ "$output" == *"find"* ]]
  [[ "$output" == *"wc"* ]]
}

# ── Research stays narrow ──────────────────────────────────────

@test "research default whitelist stays narrow and read-only" {
  run route_tools "research"
  # Required tokens present
  [[ "$output" == *"Read"* ]]
  [[ "$output" == *"Grep"* ]]
  [[ "$output" == *"Glob"* ]]
  [[ "$output" == *"curl"* ]]
  # Must NOT include write/destructive tools
  [[ "$output" != *"Write"* ]]
  [[ "$output" != *"Edit"* ]]
  [[ "$output" != *"git add"* ]]
  [[ "$output" != *"rm"* ]]
}

# ── Custom override takes precedence ──────────────────────────

@test "custom tools override wins for implementation" {
  run route_tools "implementation" "Read,Bash(echo*)"
  [ "$output" = "Read,Bash(echo*)" ]
}

# ── Generic fallback ───────────────────────────────────────────

@test "unknown task type falls back to generic whitelist" {
  run route_tools "unknown_type"
  [ "$output" = "Read,Grep,Glob,Write,Edit,Bash(git add*),Bash(git commit*),Bash(git diff*),Bash(git status*),Bash(git log*)" ]
}
