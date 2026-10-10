#!/usr/bin/env bats

load test_helper

setup() {
  # Create temp directory (copied from test_helper.bash setup function)
  export TEST_TEMP_DIR
  TEST_TEMP_DIR="$(mktemp -d)"

  # Override lock directory to per-test temp dir for isolation
  export NIGHTCREW_LOCK_DIR="$TEST_TEMP_DIR"

  # Ensure we have the lock functions available
  source "$PROJECT_ROOT/lib/run-lock.sh"
}

teardown() {
  rm -rf "$TEST_TEMP_DIR"
}

@test "fresh acquire succeeds and writes PID" {
  run acquire_run_lock
  [ "$status" -eq 0 ]
  [ -d "$TEST_TEMP_DIR/.nightcrew.lock" ]
  [ -f "$TEST_TEMP_DIR/.nightcrew.lock/pid" ]

  # Check that PID file contains a numeric value
  local pid_content
  pid_content="$(cat "$TEST_TEMP_DIR/.nightcrew.lock/pid")"
  [[ "$pid_content" =~ ^[0-9]+$ ]]

  # Check that the PID is currently alive
  kill -0 "$pid_content" 2>/dev/null
}

@test "concurrent live holder fails with error" {
  # Set up lock with current bats runner PID (guaranteed alive)
  mkdir -p "$TEST_TEMP_DIR/.nightcrew.lock"
  echo "$$" > "$TEST_TEMP_DIR/.nightcrew.lock/pid"

  # Try to acquire lock
  run acquire_run_lock
  [ "$status" -eq 1 ]
  [[ "$output" == *"Another nightcrew run is already in progress"* ]]
  [[ "$output" == *"(PID $$)"* ]]
  [[ "$output" == *"state/.nightcrew.lock is held"* ]]

  # Verify lock still exists with original PID
  [ -d "$TEST_TEMP_DIR/.nightcrew.lock" ]
  [ "$(cat "$TEST_TEMP_DIR/.nightcrew.lock/pid")" == "$$" ]
}

@test "release frees lock and allows re-acquisition" {
  # Acquire lock first (direct call, not via run)
  acquire_run_lock
  [ -d "$TEST_TEMP_DIR/.nightcrew.lock" ]

  # Release it
  release_run_lock
  [ ! -e "$TEST_TEMP_DIR/.nightcrew.lock" ]

  # Acquire again
  acquire_run_lock
  [ -d "$TEST_TEMP_DIR/.nightcrew.lock" ]

  # Test idempotent release
  release_run_lock
  release_run_lock  # Second call should not error
}

@test "stale lock from dead PID is reclaimed" {
  # Capture a dead PID from an exited subshell
  local dead_pid
  dead_pid=$(bash -c 'echo $$')

  # Verify PID is actually dead (skip test if somehow still alive)
  if kill -0 "$dead_pid" 2>/dev/null; then
    skip "Dead PID $dead_pid is somehow still alive"
  fi

  # Set up stale lock
  mkdir -p "$TEST_TEMP_DIR/.nightcrew.lock"
  echo "$dead_pid" > "$TEST_TEMP_DIR/.nightcrew.lock/pid"

  # Acquire should succeed and show reclaim message
  run acquire_run_lock
  [ "$status" -eq 0 ]
  [[ "$output" == *"Stale lock from dead PID $dead_pid"* ]]
  [[ "$output" == *"reclaiming"* ]]

  # Verify new lock has a live PID (not the dead one)
  local new_pid
  new_pid="$(cat "$TEST_TEMP_DIR/.nightcrew.lock/pid")"
  [ "$new_pid" != "$dead_pid" ]
  [[ "$new_pid" =~ ^[0-9]+$ ]]
}

@test "trap releases lock on SIGINT" {
  # Write a holder script that acquires lock and waits
  local holder_script="$TEST_TEMP_DIR/holder.sh"
  cat > "$holder_script" << 'EOF'
#!/usr/bin/env bash
source "$1/lib/run-lock.sh"
trap 'release_run_lock; exit 130' INT TERM
trap release_run_lock EXIT
acquire_run_lock
echo "ready" > "$2/ready"
sleep 30
EOF
  chmod +x "$holder_script"

  # Launch holder in background
  NIGHTCREW_LOCK_DIR="$TEST_TEMP_DIR" bash "$holder_script" "$PROJECT_ROOT" "$TEST_TEMP_DIR" &
  local holder_pid=$!

  # Wait for holder to acquire lock (up to 5 seconds)
  local wait_count=0
  while [[ ! -f "$TEST_TEMP_DIR/ready" && $wait_count -lt 50 ]]; do
    sleep 0.1
    wait_count=$((wait_count + 1))
  done

  if [[ ! -f "$TEST_TEMP_DIR/ready" ]]; then
    kill "$holder_pid" 2>/dev/null || true
    wait "$holder_pid" 2>/dev/null || true
    fail "Holder script failed to start"
  fi

  # Verify lock is held
  [ -d "$TEST_TEMP_DIR/.nightcrew.lock" ]

  # Send SIGINT and wait for exit
  kill -INT "$holder_pid"
  wait "$holder_pid" || true

  # Verify lock was released
  [ ! -e "$TEST_TEMP_DIR/.nightcrew.lock" ]
}