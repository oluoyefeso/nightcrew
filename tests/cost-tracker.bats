#!/usr/bin/env bats
# Tests for lib/cost-tracker.sh — cost estimation and token parsing

load test_helper

# Source cost-tracker (not included in test_helper by default)
source "$PROJECT_ROOT/lib/cost-tracker.sh"

setup() {
  export TEST_TEMP_DIR
  TEST_TEMP_DIR="$(mktemp -d)"
}

teardown() {
  rm -rf "$TEST_TEMP_DIR"
}

# ── estimate_cost_cents: flat-rate fallback (0 tokens) ───────

@test "estimate_cost_cents opus with 0 tokens returns flat rate 250" {
  run estimate_cost_cents "claude-opus-4-20250514" 0 0
  [ "$status" -eq 0 ]
  [ "$output" = "250" ]
}

@test "estimate_cost_cents sonnet with 0 tokens returns flat rate 50" {
  run estimate_cost_cents "claude-sonnet-4-20250514" 0 0
  [ "$status" -eq 0 ]
  [ "$output" = "50" ]
}

# ── estimate_cost_cents: real token counts ───────────────────

@test "estimate_cost_cents opus with real tokens calculates cost" {
  # Opus: $15/M input, $75/M output
  # 10000 input: 10000 * 15 / 10000 = 15
  # 5000 output:  5000 * 75 / 10000 = 37
  # Total: 52 cents
  run estimate_cost_cents "claude-opus-4-20250514" 10000 5000
  [ "$status" -eq 0 ]
  [ "$output" = "52" ]
}

@test "estimate_cost_cents sonnet with real tokens calculates cost" {
  # Sonnet: $3/M input, $15/M output
  # 10000 input: 10000 * 3 / 10000 = 3
  # 5000 output:  5000 * 15 / 10000 = 7
  # Total: 10 cents
  run estimate_cost_cents "claude-sonnet-4-20250514" 10000 5000
  [ "$status" -eq 0 ]
  [ "$output" = "10" ]
}

# ── parse_token_usage: valid JSON ────────────────────────────

@test "parse_token_usage with valid JSON returns input and output tokens" {
  cat > "$TEST_TEMP_DIR/response.json" <<'EOF'
{
  "usage": {
    "input_tokens": 1234,
    "output_tokens": 5678
  }
}
EOF
  run parse_token_usage "$TEST_TEMP_DIR/response.json"
  [ "$status" -eq 0 ]
  [ "$output" = "1234 5678" ]
}

# ── parse_token_usage: missing file ──────────────────────────

@test "parse_token_usage with missing file returns 0 0" {
  run parse_token_usage "$TEST_TEMP_DIR/nonexistent.json"
  [ "$status" -eq 0 ]
  [ "$output" = "0 0" ]
}

# ── parse_token_usage: invalid JSON ──────────────────────────

@test "parse_token_usage with invalid JSON returns 0 0" {
  echo "this is not json at all" > "$TEST_TEMP_DIR/bad.json"
  run parse_token_usage "$TEST_TEMP_DIR/bad.json"
  [ "$status" -eq 0 ]
  [ "$output" = "0 0" ]
}
