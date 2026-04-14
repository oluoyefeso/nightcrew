#!/usr/bin/env bats
# Tests for smart retry: is_retryable, extract_diagnosis, build_error_context

load test_helper

setup() {
  export TEST_TEMP_DIR
  TEST_TEMP_DIR="$(mktemp -d)"
}

teardown() {
  rm -rf "$TEST_TEMP_DIR"
}

# ── is_retryable ─────────────────────────────────────────────

@test "is_retryable returns false for exit code 139 (segfault)" {
  run is_retryable 139 ""
  [ "$status" -eq 1 ]
}

@test "is_retryable returns false for exit code 137 (OOM)" {
  run is_retryable 137 ""
  [ "$status" -eq 1 ]
}

@test "is_retryable returns false for safety refusal in stderr" {
  local stderr_file="$TEST_TEMP_DIR/stderr"
  echo "Error: content policy violation, request refused" > "$stderr_file"
  run is_retryable 1 "$stderr_file"
  [ "$status" -eq 1 ]
}

@test "is_retryable returns true for normal exit code 1" {
  run is_retryable 1 ""
  [ "$status" -eq 0 ]
}

@test "is_retryable returns true for exit code 2 with empty stderr" {
  local stderr_file="$TEST_TEMP_DIR/stderr"
  echo "some random error" > "$stderr_file"
  run is_retryable 2 "$stderr_file"
  [ "$status" -eq 0 ]
}

@test "is_retryable returns true when stderr file does not exist" {
  run is_retryable 1 "/nonexistent/path"
  [ "$status" -eq 0 ]
}

# ── extract_diagnosis ────────────────────────────────────────

@test "extract_diagnosis finds auth error in stderr" {
  local stderr_file="$TEST_TEMP_DIR/stderr"
  echo "Error: authentication error - invalid API key" > "$stderr_file"
  run extract_diagnosis "$stderr_file" ""
  [ "$status" -eq 0 ]
  [[ "$output" == *"authentication error"* ]]
}

@test "extract_diagnosis finds safety refusal in stderr" {
  local stderr_file="$TEST_TEMP_DIR/stderr"
  echo "Request refused due to content policy" > "$stderr_file"
  run extract_diagnosis "$stderr_file" ""
  [ "$status" -eq 0 ]
  [[ "$output" == *"refused"* ]]
}

@test "extract_diagnosis finds network error in stderr" {
  local stderr_file="$TEST_TEMP_DIR/stderr"
  echo "ECONNREFUSED: connection refused to api.anthropic.com" > "$stderr_file"
  run extract_diagnosis "$stderr_file" ""
  [ "$status" -eq 0 ]
  [[ "$output" == *"ECONNREFUSED"* ]]
}

@test "extract_diagnosis finds test assertion in impl log" {
  local impl_log="$TEST_TEMP_DIR/impl.log"
  cat > "$impl_log" <<'EOF'
Running tests...
  FAIL  src/auth.test.ts > login flow > should return 200
    Expected: 200
    Received: 401
EOF
  run extract_diagnosis "" "$impl_log"
  [ "$status" -eq 0 ]
  [[ "$output" == *"FAIL"* ]]
}

@test "extract_diagnosis finds SyntaxError in impl log" {
  local impl_log="$TEST_TEMP_DIR/impl.log"
  cat > "$impl_log" <<'EOF'
Compiling...
SyntaxError: Unexpected token '}' at line 42
Build completed with errors.
EOF
  run extract_diagnosis "" "$impl_log"
  [ "$status" -eq 0 ]
  [[ "$output" == *"SyntaxError"* ]]
}

@test "extract_diagnosis returns unknown error for empty inputs" {
  run extract_diagnosis "" ""
  [ "$status" -eq 0 ]
  [ "$output" = "unknown error" ]
}

@test "extract_diagnosis returns unknown error for nonexistent files" {
  run extract_diagnosis "/nonexistent" "/also-nonexistent"
  [ "$status" -eq 0 ]
  [ "$output" = "unknown error" ]
}

@test "extract_diagnosis prefers stderr over impl log" {
  local stderr_file="$TEST_TEMP_DIR/stderr"
  local impl_log="$TEST_TEMP_DIR/impl.log"
  echo "Error: permission denied accessing /etc/shadow" > "$stderr_file"
  echo "FAIL some test" > "$impl_log"
  run extract_diagnosis "$stderr_file" "$impl_log"
  [ "$status" -eq 0 ]
  [[ "$output" == *"permission denied"* ]]
}

@test "extract_diagnosis truncates long lines to 120 chars" {
  local impl_log="$TEST_TEMP_DIR/impl.log"
  # Create a line longer than 120 chars with a matching pattern
  printf 'FAIL %0.s' {1..50} > "$impl_log"
  echo "" >> "$impl_log"
  run extract_diagnosis "" "$impl_log"
  [ "$status" -eq 0 ]
  [ "${#output}" -le 120 ]
}

# ── build_error_context ──────────────────────────────────────

@test "build_error_context includes stderr section" {
  local stderr_file="$TEST_TEMP_DIR/stderr"
  echo "some error output" > "$stderr_file"
  run build_error_context "$stderr_file" "" 50
  [ "$status" -eq 0 ]
  [[ "$output" == *"=== STDERR ==="* ]]
  [[ "$output" == *"some error output"* ]]
}

@test "build_error_context includes impl log section" {
  local impl_log="$TEST_TEMP_DIR/impl.log"
  echo "implementation output here" > "$impl_log"
  run build_error_context "" "$impl_log" 50
  [ "$status" -eq 0 ]
  [[ "$output" == *"=== IMPLEMENTATION LOG"* ]]
  [[ "$output" == *"implementation output here"* ]]
}

@test "build_error_context combines both sources" {
  local stderr_file="$TEST_TEMP_DIR/stderr"
  local impl_log="$TEST_TEMP_DIR/impl.log"
  echo "stderr content" > "$stderr_file"
  echo "log content" > "$impl_log"
  run build_error_context "$stderr_file" "$impl_log" 50
  [ "$status" -eq 0 ]
  [[ "$output" == *"=== STDERR ==="* ]]
  [[ "$output" == *"stderr content"* ]]
  [[ "$output" == *"=== IMPLEMENTATION LOG"* ]]
  [[ "$output" == *"log content"* ]]
}

@test "build_error_context handles missing files gracefully" {
  run build_error_context "/nonexistent" "/also-nonexistent" 50
  [ "$status" -eq 0 ]
}

@test "build_error_context respects max_lines" {
  local impl_log="$TEST_TEMP_DIR/impl.log"
  for i in $(seq 1 100); do echo "entry-$i" >> "$impl_log"; done
  run build_error_context "" "$impl_log" 5
  [ "$status" -eq 0 ]
  [[ "$output" == *"entry-100"* ]]
  [[ "$output" != *"entry-50"* ]]
}
