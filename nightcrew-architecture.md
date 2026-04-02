# NightCrew — Overnight Claude Code Task Runner

## What This Is

An orchestrator that takes a task list, works through it autonomously using Claude Code, implements each task on its own branch, opens draft PRs, and stops when done — or pauses gracefully when it hits token/session limits and picks back up on the next cycle.

---

## System Overview

```
┌─────────────────────────────────────────────────────┐
│                    YOU (before bed)                  │
│         Write tasks.yaml → run ./nightcrew.sh       │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│                  ORCHESTRATOR (bash)                 │
│                                                     │
│  For each task:                                     │
│  1. Read task queue, skip completed                 │
│  2. Create branch + worktree                        │
│  3. PHASE 1: PLAN (Opus)                            │
│     → Scope challenge, architecture review,         │
│       test coverage plan, failure modes              │
│     → Saves PLAN-{task-id}.md                       │
│  4. PHASE 2: IMPLEMENT (Sonnet)                     │
│     → Follows the plan precisely                    │
│     → Writes code, runs tests                       │
│  5. PHASE 3: REVIEW (Sonnet)                        │
│     → Scope drift detection, critical pass,         │
│       auto-fixes mechanical issues                  │
│     → Logs concerns to REVIEW-{task-id}.md          │
│  6. Validate output                                 │
│  7. Commit, push, open draft PR                     │
│  8. Mark task complete                              │
│  9. Loop or stop                                    │
└──────────────────────┬──────────────────────────────┘
                       │
              ┌────────┴────────┐
              ▼                 ▼
        ┌──────────┐     ┌──────────┐
        │  Opus    │     │  Sonnet  │
        │ planning │     │ impl +   │
        │          │     │ review   │
        └──────────┘     └──────────┘
```

---

## Directory Structure

```
nightcrew/
├── nightcrew.sh              # Main entry point
├── config.yaml               # Global settings (repo, models, limits)
├── tasks.yaml                # Your nightly task list
├── state/
│   ├── progress.json         # Tracks status of each task
│   └── done                  # Sentinel file when session completes
├── logs/
│   ├── {task-id}-plan-{ts}.log    # Phase 1: planning output
│   ├── {task-id}-impl-{ts}.log    # Phase 2: implementation output
│   └── {task-id}-review-{ts}.log  # Phase 3: review output
├── lib/
│   ├── 00-common.sh          # Logging, config reading, utilities
│   ├── run.sh                # Core 3-phase loop (plan → impl → review)
│   ├── prompt-builder.sh     # Template rendering for all 3 phases
│   ├── model-router.sh       # Pick model per phase + task type
│   ├── tool-router.sh        # allowedTools whitelist per task type
│   ├── git-ops.sh            # Worktree, branch, commit, PR operations
│   ├── validate.sh           # Post-task checks (scope, secrets, tests)
│   ├── cost-tracker.sh       # Flat-rate cost estimation
│   ├── state.sh              # progress.json management
│   └── review.sh             # Morning review dashboard
└── templates/
    ├── plan-prompt.md         # Phase 1: Eng planning prompt (Opus)
    ├── system-prompt.md       # Phase 2: Implementation prompt (Sonnet)
    └── review-prompt.md       # Phase 3: Pre-landing review prompt (Sonnet)
```

---

## Task Definition Format (tasks.yaml)

```yaml
# Each task is a self-contained unit of work.
# The orchestrator processes them in order, one branch per task.

tasks:
  - id: fix-auth-race
    title: "Fix race condition in auth flow"
    branch: fix/auth-race-condition
    complexity: medium          # low | medium | high
    type: implementation        # research | implementation | refactor | test
    prompt: |
      There's a race condition in src/auth/login.ts where the session
      token can expire mid-request if the refresh happens concurrently.
      
      Fix the race condition using a mutex/lock pattern. Ensure existing
      tests pass and add a test for the concurrent refresh scenario.
    goal: |
      - Race condition eliminated
      - New test covers concurrent refresh
      - All existing tests pass
    files_in_scope:             # Limits what Claude can touch
      - src/auth/**
      - tests/auth/**
    max_time_minutes: 30

  - id: add-payment-tests
    title: "Unit tests for PaymentService"
    branch: test/payment-service-coverage
    complexity: medium
    type: test
    prompt: |
      Add comprehensive unit tests for src/services/payment.ts.
      Focus on edge cases: expired cards, insufficient funds,
      currency conversion rounding, and idempotency keys.
    goal: |
      - Coverage of PaymentService goes from ~40% to >85%
      - Edge cases listed above each have dedicated tests
      - Tests are isolated (no real API calls)
    files_in_scope:
      - src/services/payment.ts
      - tests/services/payment/**
    max_time_minutes: 25

  - id: research-caching
    title: "Research caching strategies for the API layer"
    branch: research/api-caching-strategy
    complexity: low
    type: research
    prompt: |
      Research caching strategies suitable for our Express API.
      Compare Redis vs in-memory vs CDN-level caching for our
      use case (50k RPM, mostly read-heavy, user-specific data).
      Write findings to docs/research/caching-strategy.md.
    goal: |
      - docs/research/caching-strategy.md exists with comparison
      - Includes pros/cons/recommendation
      - Cites sources where applicable
    files_in_scope:
      - docs/research/**
    max_time_minutes: 20

  - id: refactor-logger
    title: "Refactor logger to structured JSON"
    branch: refactor/structured-logging
    complexity: high
    type: refactor
    prompt: |
      Refactor the logger module (src/utils/logger.ts) from plain text
      to structured JSON output. Update all call sites across the
      codebase. Maintain backward compatibility via a LOG_FORMAT=text
      env var fallback.
    goal: |
      - Logger outputs structured JSON by default
      - LOG_FORMAT=text preserves old behavior
      - All call sites updated (no plain console.log remaining)
      - Existing tests updated and passing
    files_in_scope:
      - src/utils/logger.ts
      - src/**              # Needs broad access for call-site updates
      - tests/**
    max_time_minutes: 45
```

---

## Model Router Logic

Each task runs through a 3-phase pipeline. The model is selected per phase:

```
┌───────────┬──────────────┬─────────────┬────────────────────────────────┐
│ Phase     │ Task Type    │ Complexity  │ Model                          │
├───────────┼──────────────┼─────────────┼────────────────────────────────┤
│ PLAN      │ any          │ any         │ Opus   (architectural reason.) │
├───────────┼──────────────┼─────────────┼────────────────────────────────┤
│ IMPLEMENT │ research     │ any         │ Sonnet (follows plan)          │
│ IMPLEMENT │ test         │ low/medium  │ Sonnet (follows plan)          │
│ IMPLEMENT │ test         │ high        │ Opus   (complex test logic)    │
│ IMPLEMENT │ implement    │ any         │ Sonnet (follows plan)          │
│ IMPLEMENT │ refactor     │ low/medium  │ Sonnet (follows plan)          │
│ IMPLEMENT │ refactor     │ high        │ Opus   (cross-cutting changes) │
├───────────┼──────────────┼─────────────┼────────────────────────────────┤
│ REVIEW    │ any          │ any         │ Sonnet (diff analysis)         │
└───────────┴──────────────┴─────────────┴────────────────────────────────┘
```

**Key insight:** Opus drafts the plan (scope challenge, architecture decisions,
test coverage mapping, failure modes). This eliminates ambiguity so Sonnet can
follow clear instructions during implementation. Implementation tasks ALWAYS
use Sonnet because the plan does the hard thinking.

**Cost per task:** ~$3.50 (Opus plan ~$2.50 + Sonnet impl ~$0.50 + Sonnet review ~$0.50)

---

## Safety & Guardrails

### 1. Tool Restrictions (primary defense)

The orchestrator invokes Claude Code with a strict `--allowedTools` whitelist:

```bash
# CORE: file operations
TOOLS_READ="Read,Grep,Glob,LS"
TOOLS_WRITE="Write,Edit"

# GIT: only specific, safe operations
TOOLS_GIT="Bash(git checkout),Bash(git checkout -b),Bash(git add),Bash(git commit),Bash(git push),Bash(git diff),Bash(git status),Bash(git log)"

# SEARCH: curl for research ONLY (GET requests, no POST/PUT/DELETE)
TOOLS_NET="Bash(curl -s -L --max-time 10 --max-filesize 1048576)"

# BUILD/TEST: run tests, linting
TOOLS_BUILD="Bash(npm test),Bash(npm run lint),Bash(npx tsc --noEmit)"

# COMBINE
ALLOWED_TOOLS="${TOOLS_READ},${TOOLS_WRITE},${TOOLS_GIT},${TOOLS_NET},${TOOLS_BUILD}"
```

### 2. Explicitly Blocked (what Claude CANNOT do)

- `npm publish`, `npm install -g`, `yarn publish`
- `git push --force`, `git push origin main`, `git merge`
- `curl -X POST`, `curl -X PUT`, `curl -X DELETE` (no write operations to the internet)
- `rm -rf`, `sudo`, `chmod`, `chown`
- `open`, `xdg-open` (no launching browsers/apps)
- Any `pip install`, `brew install`, or package manager that modifies global state
- `ssh`, `scp`, `rsync` to remote hosts
- `.env` reads (add to disallowed file patterns)

### 3. Branch Protection

```bash
# Before every Claude Code invocation
current_branch=$(git branch --show-current)
if [[ "$current_branch" == "main" || "$current_branch" == "master" || "$current_branch" == "develop" ]]; then
    echo "FATAL: Refusing to run on protected branch: $current_branch"
    exit 1
fi
```

Also configure on your Git remote:
- Require PR reviews before merge
- Disable direct push to main/master
- Require status checks to pass

### 4. File Scope Enforcement

Each task declares `files_in_scope`. The system prompt tells Claude it may only modify files matching those patterns. The validator checks post-execution that no out-of-scope files were changed:

```bash
changed_files=$(git diff --name-only HEAD~1)
for file in $changed_files; do
    if ! matches_scope "$file" "$task_scope"; then
        echo "VIOLATION: $file modified but not in scope"
        git checkout HEAD~1 -- "$file"  # revert the violation
    fi
done
```

### 5. Network Restrictions

```bash
# Option A: iptables (Linux)
# Only allow DNS + HTTPS to known search/docs domains
iptables -A OUTPUT -p tcp --dport 443 -d github.com -j ACCEPT
iptables -A OUTPUT -p tcp --dport 443 -d stackoverflow.com -j ACCEPT
iptables -A OUTPUT -p tcp --dport 443 -d developer.mozilla.org -j ACCEPT
iptables -A OUTPUT -p tcp --dport 443 -d docs.python.org -j ACCEPT
# ... add your domain allowlist
iptables -A OUTPUT -p tcp --dport 443 -j DROP   # block everything else

# Option B: Use a proxy that only allows GET requests
# (simpler, catches more edge cases)
```

### 6. Timeout Per Task

```bash
timeout "${task_max_time}m" claude -p "$prompt" --allowedTools "$ALLOWED_TOOLS"
exit_code=$?
if [[ $exit_code -eq 124 ]]; then
    echo "Task timed out after ${task_max_time} minutes"
    mark_task "timeout" "$task_id"
fi
```

### 7. Cost Cap

Track estimated token usage across the session. If cumulative spend exceeds a threshold, stop:

```bash
if [[ $(get_estimated_cost) -gt $MAX_SESSION_COST_CENTS ]]; then
    echo "Cost cap reached. Pausing remaining tasks."
    save_progress
    exit 0
fi
```

---

## Token / Session Limit Handling

This is the "pause and retry on refresh" logic.

### How It Works

```
Session starts at 00:00 (midnight)
├── Task 1: fix-auth-race ............ ✅ done (used ~40k tokens)
├── Task 2: add-payment-tests ........ ✅ done (used ~30k tokens)
├── Task 3: research-caching ......... ✅ done (used ~15k tokens)
├── Task 4: refactor-logger ......... ⏸  PAUSED (hit session limit)
│
│   [orchestrator detects rate limit / token exhaustion]
│   [writes state to progress.json]
│   [sleeps until next refresh window]
│
├── ... sleeping until 05:00 (token refresh) ...
│
├── Task 4: refactor-logger ......... 🔄 RESUMED → ✅ done
└── ALL TASKS COMPLETE → exit 0
```

### Detection

Claude Code returns specific exit codes or error messages when hitting limits. The orchestrator watches for:

```bash
# After each Claude Code invocation
if echo "$output" | grep -qi "rate limit\|token limit\|capacity\|exceeded"; then
    echo "Session limit detected. Saving progress."
    save_state "$task_id" "paused" "$output"
    
    # Calculate sleep duration until next refresh
    # (varies by plan — Pro resets differ from Max)
    sleep_until_refresh
    
    # Resume
    resume_from_state
fi
```

### State File (state/progress.json)

```json
{
  "session_started": "2026-04-01T00:00:00Z",
  "tasks": {
    "fix-auth-race": {
      "status": "complete",
      "branch": "fix/auth-race-condition",
      "pr_url": "https://github.com/you/repo/pull/42",
      "started_at": "2026-04-01T00:01:12Z",
      "completed_at": "2026-04-01T00:18:44Z",
      "tokens_estimated": 41200
    },
    "add-payment-tests": {
      "status": "complete",
      "branch": "test/payment-service-coverage",
      "pr_url": "https://github.com/you/repo/pull/43",
      "started_at": "2026-04-01T00:19:01Z",
      "completed_at": "2026-04-01T00:38:22Z",
      "tokens_estimated": 29800
    },
    "refactor-logger": {
      "status": "paused",
      "branch": "refactor/structured-logging",
      "paused_at": "2026-04-01T01:45:00Z",
      "resume_after": "2026-04-01T05:00:00Z",
      "partial_progress": "Created branch, updated logger.ts, 12/47 call sites updated"
    }
  }
}
```

---

## The Orchestrator Core Loop (pseudocode)

```bash
#!/bin/bash
# nightcrew.sh — main entry point

set -euo pipefail

REPO_DIR=$(read_config "repo_path")
TASKS_FILE="./tasks.yaml"
STATE_FILE="./state/progress.json"
MAX_COST_CENTS=$(read_config "max_cost_cents" 500)  # $5 default cap

cd "$REPO_DIR"
ensure_clean_working_tree
ensure_not_on_protected_branch

# Load tasks
tasks=$(parse_yaml "$TASKS_FILE")

# Load existing progress (for resume)
init_or_load_state "$STATE_FILE"

for task in $tasks; do
    task_id=$(get_field "$task" "id")
    task_status=$(get_task_status "$task_id")

    # Skip completed tasks
    if [[ "$task_status" == "complete" ]]; then
        log "Skipping $task_id (already complete)"
        continue
    fi

    # Check cost cap
    if over_cost_cap "$MAX_COST_CENTS"; then
        log "Cost cap reached. Stopping."
        break
    fi

    # Set up branch
    branch=$(get_field "$task" "branch")
    if [[ "$task_status" == "paused" ]]; then
        git checkout "$branch"
        log "Resuming $task_id on existing branch $branch"
    else
        git checkout main && git pull origin main
        git checkout -b "$branch"
        log "Starting $task_id on new branch $branch"
    fi

    # Verify we're not on a protected branch
    assert_not_protected_branch

    # Route to model
    model=$(route_model "$(get_field "$task" "type")" "$(get_field "$task" "complexity")")

    # Build the sandboxed prompt
    system_prompt=$(build_system_prompt "$task")
    user_prompt=$(get_field "$task" "prompt")
    allowed_tools=$(build_tool_whitelist "$task")
    max_time=$(get_field "$task" "max_time_minutes" 30)

    # Execute with timeout
    mark_task "in_progress" "$task_id"
    
    output=$(timeout "${max_time}m" \
        claude -p "$user_prompt" \
            --model "$model" \
            --systemPrompt "$system_prompt" \
            --allowedTools "$allowed_tools" \
        2>&1 | tee "logs/${task_id}-$(date +%s).log")
    
    exit_code=$?

    # Handle outcomes
    if [[ $exit_code -eq 124 ]]; then
        # Timeout
        mark_task "timeout" "$task_id"
        git add -A && git commit -m "WIP: $task_id (timed out)" || true
        continue

    elif detected_rate_limit "$output"; then
        # Token/session limit hit
        git add -A && git commit -m "WIP: $task_id (paused - rate limit)" || true
        git push origin "$branch" 2>/dev/null || true
        mark_task "paused" "$task_id"
        
        log "Rate limit hit. Sleeping until refresh..."
        sleep_until_refresh
        
        # After waking, re-run this task
        # (the loop will pick it up as "paused" on next iteration)
        exec "$0"  # restart the script to pick up from state

    elif [[ $exit_code -eq 0 ]]; then
        # Success path
        validate_output "$task"
        
        git add -A
        git commit -m "feat($task_id): $(get_field "$task" "title")"
        git push origin "$branch"

        # Open draft PR
        pr_url=$(gh pr create \
            --title "$(get_field "$task" "title")" \
            --body "$(render_pr_body "$task" "$output")" \
            --draft \
            --base main \
            --head "$branch")

        mark_task "complete" "$task_id" "$pr_url"
        log "✅ $task_id complete → $pr_url"
    else
        # Unknown failure
        mark_task "failed" "$task_id" "$output"
        log "❌ $task_id failed with exit code $exit_code"
        continue
    fi
done

# Summary
print_summary
log "NightCrew session complete. $(count_completed) tasks done, $(count_remaining) remaining."
```

---

## System Prompt Templates (3-phase pipeline)

Each task runs through three separate Claude Code invocations, each with its
own system prompt optimized for that phase:

### Phase 1: Plan (`templates/plan-prompt.md`) — Opus

The planning prompt instructs Opus to:
1. **Scope challenge** — check for existing solutions, minimize file count, search for built-ins
2. **Architecture review** — design decisions using boring-by-default, blast radius, reversibility principles
3. **Code quality review** — DRY, error handling, over/under-engineering
4. **Test coverage plan** — ASCII diagrams of every codepath, specific tests to write
5. **Performance review** — N+1 queries, memory, caching
6. **Failure mode analysis** — realistic production failures per codepath

Output: `PLAN-{task-id}.md` — a structured plan with decisions locked in, no open questions.

### Phase 2: Implement (`templates/system-prompt.md`) — Sonnet

The implementation prompt includes the original task PLUS the plan injected
as a `<plan>` block. Sonnet follows the plan precisely. If it deviates, it
documents why in `DECISIONS-{task-id}.md`.

### Phase 3: Review (`templates/review-prompt.md`) — Sonnet

The review prompt runs a pre-landing code review:
1. **Scope drift detection** — did it build what was requested?
2. **Plan completion audit** — cross-reference plan items against the diff
3. **Critical pass** — SQL safety, race conditions, XSS, shell injection, enum completeness
4. **Fix-first review** — auto-fix mechanical issues, log ambiguous ones to `REVIEW-{task-id}.md`

The human reviews `REVIEW-{task-id}.md` in the morning alongside the draft PR.

---

## Post-Run Validation Checks

After each task, before committing:

```bash
validate_output() {
    local task="$1"
    local violations=0

    # 1. No changes to protected files
    check_file_scope "$task" || ((violations++))

    # 2. No secrets/credentials accidentally committed
    if git diff --cached | grep -iE "(api_key|secret|password|token)\s*=" ; then
        echo "WARNING: Possible secret in diff"
        ((violations++))
    fi

    # 3. Tests pass (if applicable)
    if [[ "$(get_field "$task" "type")" != "research" ]]; then
        npm test 2>&1 || ((violations++))
    fi

    # 4. No giant files accidentally added
    large_files=$(git diff --cached --stat | awk '$3 > 10000 {print $1}')
    if [[ -n "$large_files" ]]; then
        echo "WARNING: Large file changes detected: $large_files"
        ((violations++))
    fi

    # 5. Branch is correct
    current=$(git branch --show-current)
    expected=$(get_field "$task" "branch")
    if [[ "$current" != "$expected" ]]; then
        echo "FATAL: On wrong branch. Expected $expected, got $current"
        ((violations++))
    fi

    return $violations
}
```

---

## Config File (config.yaml)

```yaml
repo_path: /Users/you/projects/your-repo
max_cost_cents: 500              # $5 per night cap
max_task_time_minutes: 45        # absolute ceiling per task
token_refresh_hour: 5            # hour (local time) when limits reset

models:
  default: claude-sonnet-4-20250514
  complex: claude-opus-4-20250514
  quick: claude-haiku-4-5-20251001

protected_branches:
  - main
  - master
  - develop
  - production

network_allowlist:
  - github.com
  - stackoverflow.com
  - developer.mozilla.org
  - docs.python.org
  - nodejs.org
  - npmjs.com
  - pkg.go.dev

pr_defaults:
  draft: true
  base: main
  reviewers: []                  # Add GitHub usernames for auto-assign
```

---

## Getting Started (implementation order)

### Phase 1 — Minimum Viable NightCrew
1. `tasks.yaml` parser (use `yq` or a small Python script)
2. Core loop: iterate tasks, create branches, invoke Claude Code
3. `--allowedTools` whitelist (hardcoded initially)
4. Draft PR creation via `gh` CLI
5. Basic logging to files

### Phase 2 — Resilience
6. `progress.json` state tracking (skip completed, resume paused)
7. Rate limit detection and sleep-until-refresh
8. Timeout enforcement per task
9. Post-task validation (scope check, test runner, secret scan)

### Phase 3 — Intelligence  
10. Model router (Sonnet vs Opus based on task metadata)
11. Cost estimation and cap enforcement
12. PR body generation with task summary + diff stats
13. Morning summary (email/Slack notification when all tasks done)

### Phase 4 — Hardening
14. Network allowlist enforcement (iptables or proxy)
15. File scope enforcement with automatic revert on violation
16. Retry logic for flaky failures (network timeouts, etc.)
17. Dry-run mode (`--dry-run` to preview what would happen)

---

## Usage

```bash
# Before bed
vim tasks.yaml                   # Define tonight's work
./nightcrew.sh                   # Start the run

# Or schedule it
echo "0 0 * * * cd ~/nightcrew && ./nightcrew.sh" | crontab -

# In the morning
cat state/progress.json | jq '.tasks | to_entries[] | "\(.value.status) \(.key)"'
# complete fix-auth-race
# complete add-payment-tests
# complete research-caching
# complete refactor-logger

# Review the draft PRs on GitHub
```
