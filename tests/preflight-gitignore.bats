#!/usr/bin/env bats
# Tests for lib/preflight-gitignore.sh
#
# Each test builds an isolated git repo under TEST_TEMP_DIR.
# The real git binary is used — no mocking.

load test_helper

# ── Fixture helpers ────────────────────────────────────────────────────────

# _make_repo <dir>  — initialise a bare-minimum git repo
_make_repo() {
  local dir="$1"
  mkdir -p "$dir"
  git init -b main "$dir" >/dev/null 2>&1 \
    || git init "$dir" >/dev/null 2>&1
  git -C "$dir" config user.email "test@example.com"
  git -C "$dir" config user.name "NightCrew Test"
  # Seed with an empty commit so HEAD is valid
  git -C "$dir" commit --allow-empty -m "init" >/dev/null 2>&1
}

# ── Test 1: clean case ─────────────────────────────────────────────────────

@test "1: lib/** against tracked files returns 0 and reports no violations" {
  local repo="$TEST_TEMP_DIR/repo"
  _make_repo "$repo"

  # Create and commit a tracked file under lib/
  mkdir -p "$repo/lib"
  echo "# util" > "$repo/lib/util.sh"
  git -C "$repo" add lib/util.sh
  git -C "$repo" commit -m "add lib/util.sh" >/dev/null 2>&1

  cat > "$TEST_TEMP_DIR/tasks.yaml" <<'EOF'
tasks:
  - id: task-clean
    title: Clean task
    branch: feat/clean
    type: implementation
    prompt: Do something clean
    files_in_scope:
      - lib/**
EOF

  # Override config_get so repo_path resolves to our fixture
  config_get() {
    case "$1" in
      repo_path) echo "$repo" ;;
      *) echo "${2:-}" ;;
    esac
  }

  run check_files_in_scope_gitignored "$TEST_TEMP_DIR/tasks.yaml" ""
  [ "$status" -eq 0 ]
  [[ "$output" == *"no gitignored targets"* ]]
}

# ── Test 2: literal gitignored path ────────────────────────────────────────

@test "2: literal gitignored path returns 1 with GITIGNORED error and .gitignore reference" {
  local repo="$TEST_TEMP_DIR/repo"
  _make_repo "$repo"

  # Add design/ to .gitignore and commit it
  echo "design/" > "$repo/.gitignore"
  git -C "$repo" add .gitignore
  git -C "$repo" commit -m "ignore design/" >/dev/null 2>&1

  # Create the gitignored file on disk (exists but gitignored)
  mkdir -p "$repo/design/nocturnal_command"
  echo "# DESIGN" > "$repo/design/nocturnal_command/DESIGN.md"

  cat > "$TEST_TEMP_DIR/tasks.yaml" <<'EOF'
tasks:
  - id: promote-design
    title: Promote DESIGN.md
    branch: feat/promote
    type: implementation
    prompt: Move the design doc
    files_in_scope:
      - design/nocturnal_command/DESIGN.md
EOF

  config_get() {
    case "$1" in
      repo_path) echo "$repo" ;;
      *) echo "${2:-}" ;;
    esac
  }

  run check_files_in_scope_gitignored "$TEST_TEMP_DIR/tasks.yaml" ""
  [ "$status" -eq 1 ]
  [[ "$output" == *"[GITIGNORED]"* ]]
  [[ "$output" == *"design/nocturnal_command/DESIGN.md"* ]]
  [[ "$output" == *".gitignore:"* ]]
}

# ── Test 3: glob pattern with gitignored directory matches ─────────────────

@test "3: state/** against gitignored state/ returns 1" {
  local repo="$TEST_TEMP_DIR/repo"
  _make_repo "$repo"

  # Gitignore state/
  echo "state/" > "$repo/.gitignore"
  git -C "$repo" add .gitignore
  git -C "$repo" commit -m "ignore state/" >/dev/null 2>&1

  # Create gitignored files under state/
  mkdir -p "$repo/state"
  echo '{"session":"abc"}' > "$repo/state/session.json"
  echo "run.lock" > "$repo/state/.nightcrew.lock"

  cat > "$TEST_TEMP_DIR/tasks.yaml" <<'EOF'
tasks:
  - id: read-state
    title: Read state files
    branch: feat/state
    type: research
    prompt: Analyse state
    files_in_scope:
      - state/**
EOF

  config_get() {
    case "$1" in
      repo_path) echo "$repo" ;;
      *) echo "${2:-}" ;;
    esac
  }

  run check_files_in_scope_gitignored "$TEST_TEMP_DIR/tasks.yaml" ""
  [ "$status" -eq 1 ]
  [[ "$output" == *"[GITIGNORED]"* ]]
}

# ── Test 4: task without files_in_scope is skipped cleanly ─────────────────

@test "4: task with no files_in_scope field returns 0" {
  local repo="$TEST_TEMP_DIR/repo"
  _make_repo "$repo"

  cat > "$TEST_TEMP_DIR/tasks.yaml" <<'EOF'
tasks:
  - id: no-scope
    title: No scope task
    branch: feat/noscope
    type: research
    prompt: Just research, no files_in_scope
EOF

  config_get() {
    case "$1" in
      repo_path) echo "$repo" ;;
      *) echo "${2:-}" ;;
    esac
  }

  run check_files_in_scope_gitignored "$TEST_TEMP_DIR/tasks.yaml" ""
  [ "$status" -eq 0 ]
  [[ "$output" == *"no gitignored targets"* ]]
}

# ── Test 5: pure wildcard glob with no matching files returns 0 ────────────

@test "5: **/*.test.ts with no matching files returns 0" {
  local repo="$TEST_TEMP_DIR/repo"
  _make_repo "$repo"
  # No .test.ts files exist in the repo

  cat > "$TEST_TEMP_DIR/tasks.yaml" <<'EOF'
tasks:
  - id: test-files
    title: Test files task
    branch: feat/tests
    type: test
    prompt: Add tests
    files_in_scope:
      - "**/*.test.ts"
EOF

  config_get() {
    case "$1" in
      repo_path) echo "$repo" ;;
      *) echo "${2:-}" ;;
    esac
  }

  run check_files_in_scope_gitignored "$TEST_TEMP_DIR/tasks.yaml" ""
  [ "$status" -eq 0 ]
  [[ "$output" == *"no gitignored targets"* ]]
}

# ── Test 6: multi-project — check runs against the task's project_path ─────

@test "6: multi-project task checks files_in_scope against task project_path" {
  # repo1: the default repo (no violations)
  local repo1="$TEST_TEMP_DIR/repo1"
  _make_repo "$repo1"
  mkdir -p "$repo1/lib"
  echo "# ok" > "$repo1/lib/ok.sh"
  git -C "$repo1" add lib/ok.sh
  git -C "$repo1" commit -m "add lib/ok.sh" >/dev/null 2>&1

  # repo2: a different project where vendor/ is gitignored
  local repo2="$TEST_TEMP_DIR/repo2"
  _make_repo "$repo2"
  echo "vendor/" > "$repo2/.gitignore"
  git -C "$repo2" add .gitignore
  git -C "$repo2" commit -m "ignore vendor/" >/dev/null 2>&1

  # Create gitignored file in repo2
  mkdir -p "$repo2/vendor"
  echo "module.exports = {}" > "$repo2/vendor/dep.js"

  # The task explicitly targets repo2 via project_path
  cat > "$TEST_TEMP_DIR/tasks.yaml" <<EOF
tasks:
  - id: vendor-task
    title: Use vendor deps
    branch: feat/vendor
    type: implementation
    prompt: Use the vendored dep
    project_path: $repo2
    files_in_scope:
      - vendor/**
EOF

  # config_get returns repo1 as default — but the task overrides via project_path
  config_get() {
    case "$1" in
      repo_path) echo "$repo1" ;;
      *) echo "${2:-}" ;;
    esac
  }

  run check_files_in_scope_gitignored "$TEST_TEMP_DIR/tasks.yaml" ""
  [ "$status" -eq 1 ]
  [[ "$output" == *"[GITIGNORED]"* ]]
  [[ "$output" == *"vendor"* ]]
}
