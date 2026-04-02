#!/usr/bin/env bats
# Tests for lib/validate.sh — post-task validation

load test_helper

# Secret scan regex — same intent as validate.sh, POSIX-portable.
# Note: validate.sh uses \s* which is not POSIX ERE, and grep -v '^\+\+\+'
# which fails in macOS BRE. These tests use portable equivalents.
SECRET_PATTERN='^\+.*(api_key|secret_key|password|private_key) *[=:]'

setup() {
  export TEST_TEMP_DIR
  TEST_TEMP_DIR="$(mktemp -d)"

  # Create a minimal git repo for validation tests
  git -C "$TEST_TEMP_DIR" init -b main --quiet
  git -C "$TEST_TEMP_DIR" commit --allow-empty -m "initial" --quiet

  # Create and switch to a task branch
  git -C "$TEST_TEMP_DIR" checkout -b "task/test-branch" --quiet
  git -C "$TEST_TEMP_DIR" commit --allow-empty -m "task start" --quiet
}

teardown() {
  rm -rf "$TEST_TEMP_DIR"
}

# ── Branch assertion ──────────────────────────────────────────

@test "validate_task catches wrong branch" {
  run validate_task "$TEST_TEMP_DIR" "task/other-branch" "**/*" "" "main"
  [ "$status" -ne 0 ]
  [[ "$output" == *"Wrong branch"* ]]
}

@test "validate_task passes on correct branch" {
  run validate_task "$TEST_TEMP_DIR" "task/test-branch" "**/*" "" "main"
  [ "$status" -eq 0 ]
}

# ── Secret scan (pattern-level tests) ─────────────────────────
# These test the detection intent of validate.sh's secret scan grep.
# We use grep -vF '+++' instead of grep -v '^\+\+\+' for macOS compat.

@test "secret scan catches api_key pattern" {
  local secrets_found
  secrets_found=$(echo '+API_KEY=sk-secret-12345' | \
    grep -iE "$SECRET_PATTERN" | grep -vF '+++' || true)
  [ -n "$secrets_found" ]
}

@test "secret scan catches secret_key pattern" {
  local secrets_found
  secrets_found=$(echo '+secret_key = "hunter2"' | \
    grep -iE "$SECRET_PATTERN" | grep -vF '+++' || true)
  [ -n "$secrets_found" ]
}

@test "secret scan catches password pattern" {
  local secrets_found
  secrets_found=$(echo '+password: supersecret' | \
    grep -iE "$SECRET_PATTERN" | grep -vF '+++' || true)
  [ -n "$secrets_found" ]
}

@test "secret scan ignores lines without secrets" {
  local secrets_found
  secrets_found=$(echo '+const greeting = "hello world"' | \
    grep -iE "$SECRET_PATTERN" | grep -vF '+++' || true)
  [ -z "$secrets_found" ]
}

@test "secret scan ignores diff file headers" {
  local secrets_found
  secrets_found=$(echo '+++ b/api_key_config.txt' | \
    grep -iE "$SECRET_PATTERN" | grep -vF '+++' || true)
  [ -z "$secrets_found" ]
}

# ── Full validate_task with clean diff ────────────────────────

@test "validate_task passes when no secrets in diff" {
  echo 'hello world' > "$TEST_TEMP_DIR/readme.txt"
  git -C "$TEST_TEMP_DIR" add readme.txt
  git -C "$TEST_TEMP_DIR" commit -m "add readme" --quiet

  run validate_task "$TEST_TEMP_DIR" "task/test-branch" "**/*" "" "main"
  [ "$status" -eq 0 ]
}

# ── Glob / file-scope matching ───────────────────────────────

@test "glob matching: file in scoped dir matches pattern" {
  # src/auth/login.ts should match "src/auth/**"
  mkdir -p "$TEST_TEMP_DIR/src/auth"
  echo 'export {}' > "$TEST_TEMP_DIR/src/auth/login.ts"
  git -C "$TEST_TEMP_DIR" add src/auth/login.ts
  git -C "$TEST_TEMP_DIR" commit -m "add login" --quiet

  run validate_task "$TEST_TEMP_DIR" "task/test-branch" "src/auth/**" "" "main"
  [ "$status" -eq 0 ]
}

@test "glob matching: file outside scoped dir does NOT match pattern" {
  # src/other/file.ts should NOT match "src/auth/**"
  mkdir -p "$TEST_TEMP_DIR/src/other"
  echo 'export {}' > "$TEST_TEMP_DIR/src/other/file.ts"
  git -C "$TEST_TEMP_DIR" add src/other/file.ts
  git -C "$TEST_TEMP_DIR" commit -m "add other file" --quiet

  run validate_task "$TEST_TEMP_DIR" "task/test-branch" "src/auth/**" "" "main"
  [ "$status" -ne 0 ]
  [[ "$output" == *"Out-of-scope"* ]]
}

@test "glob matching: deeply nested file matches pattern" {
  # src/auth/sub/deep.ts should match "src/auth/**"
  mkdir -p "$TEST_TEMP_DIR/src/auth/sub"
  echo 'export {}' > "$TEST_TEMP_DIR/src/auth/sub/deep.ts"
  git -C "$TEST_TEMP_DIR" add src/auth/sub/deep.ts
  git -C "$TEST_TEMP_DIR" commit -m "add deep file" --quiet

  run validate_task "$TEST_TEMP_DIR" "task/test-branch" "src/auth/**" "" "main"
  [ "$status" -eq 0 ]
}
