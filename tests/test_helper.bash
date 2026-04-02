#!/usr/bin/env bash
# Common test helper — sourced by all .bats files
#
# Requires bash 4+ for associative arrays (used in lib/run.sh).
# On macOS, run tests with:
#   SHELL=/opt/homebrew/bin/bash bats tests/
# Or install bash 5: brew install bash

# Project root
export PROJECT_ROOT="${BATS_TEST_DIRNAME}/.."
export NIGHTCREW_DIR="$PROJECT_ROOT"

# Create a temp directory for each test
setup() {
  export TEST_TEMP_DIR
  TEST_TEMP_DIR="$(mktemp -d)"
}

teardown() {
  rm -rf "$TEST_TEMP_DIR"
}

# Source lib modules in order (00-common first, then alphabetical)
source "$PROJECT_ROOT/lib/00-common.sh"
source "$PROJECT_ROOT/lib/state.sh"
source "$PROJECT_ROOT/lib/model-router.sh"
source "$PROJECT_ROOT/lib/tool-router.sh"
source "$PROJECT_ROOT/lib/validate.sh"
source "$PROJECT_ROOT/lib/run.sh"

# ── Mock helpers ──────────────────────────────────────────────

# Override config_get to return predictable defaults without needing yq
# Individual tests can override this again if needed.
config_get() {
  local key="$1"
  local default="${2:-}"
  case "$key" in
    models.default)  echo "${MOCK_DEFAULT_MODEL:-claude-sonnet-4-20250514}" ;;
    models.complex)  echo "${MOCK_COMPLEX_MODEL:-claude-opus-4-20250514}" ;;
    *)               echo "$default" ;;
  esac
}

# Stub yq for tests that don't need real YAML parsing.
# Tests that DO need yq (deps, schema) should override or use the real binary.
mock_yq() {
  # Creates a yq function that returns canned responses
  # Usage: mock_yq "response1" "response2" ...
  # Each call to yq returns the next response
  export MOCK_YQ_RESPONSES=("$@")
  export MOCK_YQ_CALL_COUNT=0
}

# Stub git for validate.sh tests
mock_git() {
  git() {
    local subcmd=""
    # Find the subcommand (skip -C dir)
    local args=("$@")
    local i=0
    while [[ $i -lt ${#args[@]} ]]; do
      case "${args[$i]}" in
        -C) ((i+=2)) ;;
        *)
          subcmd="${args[$i]}"
          break
          ;;
      esac
    done

    case "$subcmd" in
      branch)
        echo "${MOCK_GIT_BRANCH:-test-branch}"
        ;;
      diff)
        echo "${MOCK_GIT_DIFF:-}"
        ;;
      status)
        echo "${MOCK_GIT_STATUS:-}"
        ;;
      *)
        command git "$@"
        ;;
    esac
  }
  export -f git
}
