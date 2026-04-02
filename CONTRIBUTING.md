# Contributing to NightCrew

Thanks for your interest in contributing. NightCrew is a bash project with zero compiled dependencies, so getting started is fast.

## Setup

```bash
# Clone the repo
git clone <repo-url> && cd nightcrew

# Make the entry point executable
chmod +x nightcrew.sh

# Install dependencies
brew install jq yq gettext
brew install bats-core  # for running tests

# Install Node dependency (for web UI server)
npm install

# Verify everything works
bats tests/
```

**Required tools:** `bash` (4.0+), `jq`, `yq`, `envsubst` (from gettext), `bats-core` (for tests), `node` (for web UI server).

**Note for macOS users:** The default `/bin/bash` on macOS is 3.2 (ancient). NightCrew requires bash 4+ for associative arrays. Install modern bash: `brew install bash`. Tests will use the Homebrew version automatically if available.

## Running Tests

```bash
# Run all tests
bats tests/

# Run a specific test file
bats tests/state.bats

# Run with verbose output
bats tests/ --verbose-run
```

The test suite covers: state machine transitions, model/tool routing, schema validation, dependency resolution, cost tracking, and file scope enforcement. See `tests/` for the full list.

## Project Structure

```
nightcrew/
  nightcrew.sh              # Entry point (run, review, serve, preflight, config)
  server.js                 # Web UI server (Node.js, started via nightcrew serve)
  index.html                # Web UI single-page app (4 pages + overlay)
  package.json              # Node dependency (js-yaml)
  config.yaml.example       # User settings (repo path, cost cap, models)
  tasks.yaml.example        # Example task queue
  dashboard.html            # Static morning review dashboard (file:// fallback)
  schemas/
    task.schema.json         # JSON Schema for tasks.yaml validation
  design/                    # UI design mockups and design system (DESIGN.md)
  lib/
    00-common.sh             # Logging, config reading, utilities
    run.sh                   # Core 3-phase loop + preflight/config commands
    state.sh                 # progress.json state machine + session archiving
    model-router.sh          # Opus vs Sonnet routing per phase
    tool-router.sh           # allowedTools whitelist per task type
    prompt-builder.sh        # Template rendering with envsubst
    git-ops.sh               # Worktree, branch, commit, PR operations
    validate.sh              # Post-task scope, secret, and test checks
    cost-tracker.sh          # Token-based and flat-rate cost estimation
    review.sh                # Morning review CLI dashboard
  templates/
    plan-prompt.md           # Phase 1: Engineering planning prompt (Opus)
    system-prompt.md         # Phase 2: Implementation prompt (Sonnet)
    review-prompt.md         # Phase 3: Pre-landing review prompt (Sonnet)
  state/
    progress.json            # Current run status (overwritten each run)
    sessions/                # Archived sessions (one folder per run)
  tests/
    test_helper.bash         # Common test setup
    state.bats               # State machine tests
    routing.bats             # Model + tool routing tests
    validate.bats            # Validation + glob matching tests
    deps.bats                # Dependency resolution tests
    schema.bats              # Schema validation tests
    cost-tracker.bats        # Cost estimation tests
    git-ops.bats             # Worktree setup + hardening tests
    fixtures/                # Test YAML fixtures
```

## How to Contribute

1. **Check TODOS.md** for planned work. Pick something that interests you.
2. **Open an issue first** for anything not in TODOS.md, so we can discuss scope.
3. **Fork, branch, PR.** Use a descriptive branch name (`fix/glob-matching`, `feat/parallel-exec`).
4. **Write tests.** Every new feature or bug fix should include tests. Run `bats tests/` before submitting.
5. **Keep it simple.** The core pipeline is pure bash. The web UI uses a minimal Node.js server (one dependency: js-yaml). Don't add frameworks or build steps.

## Code Style

- Pure bash. No external language runtimes.
- Functions are grouped by module in `lib/`.
- Modules are sourced in order by `nightcrew.sh` (00-common.sh loads first).
- Use `log` and `log_error` for output (defined in `lib/00-common.sh`).
- Use `config_get` to read config.yaml values with defaults.
- Prefix temp files with `/tmp/nightcrew-`.

## What Makes a Good PR

- **Small and focused.** One feature or fix per PR.
- **Tests included.** Add a `.bats` test or extend an existing one.
- **Docs updated.** If you change behavior, update README.md or the relevant template.
- **No scope creep.** If you find something else to fix, open a separate issue/PR.
