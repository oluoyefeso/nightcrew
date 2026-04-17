# Implementation Plan: Add lockfile to prevent concurrent nightcrew runs

## Scope Decision
Add a new `lib/run-lock.sh` with two functions (`acquire_run_lock`, `release_run_lock`) using atomic `mkdir`-based locking at `$NIGHTCREW_DIR/state/.nightcrew.lock`. Wire the acquire call + EXIT trap at the top of `nightcrew_run()` in `lib/run.sh` (BEFORE `preflight_check`). Add `tests/run-lockfile.bats` with five cases. Move the TODOS.md entry to Completed. Nothing else changes. Explicitly excluded: per-project locks, `flock`, blocking waits, retries, lock on non-`run` subcommands, CHANGELOG edits, VERSION bump.

## What Already Exists
- `nightcrew.sh` auto-sources every `lib/*.sh` via glob at lines 15–18 — dropping `lib/run-lock.sh` into `lib/` is enough to source it. **Reuse as-is.** No new source line needed.
- `nightcrew_run()` at `lib/run.sh:731` already installs a signal trap at line 736: `trap cleanup_on_signal SIGINT SIGTERM SIGHUP`. `cleanup_on_signal` ends with `exit 1`, which triggers any EXIT trap. **Extend** — add a separate EXIT trap for `release_run_lock`; do not replace or rewrite the existing SIGINT/SIGTERM/SIGHUP trap.
- `$NIGHTCREW_DIR` is resolved in `nightcrew.sh:11` from `BASH_SOURCE`. All other state paths use `$NIGHTCREW_DIR/state/...` (e.g., `lib/state.sh:111`, `lib/review.sh:7`). **Reuse** — anchor the lock to `$NIGHTCREW_DIR/state`, not cwd.
- `tests/test_helper.bash` already sets `NIGHTCREW_DIR=$PROJECT_ROOT` and creates a per-test `TEST_TEMP_DIR`. **Reuse** — tests override the lock dir by setting a single env var.
- No existing bats test invokes `nightcrew.sh run` (confirmed via grep). There is therefore zero risk of the lockfile change breaking `tests/cli-commands.bats` or any other existing suite.

## Architecture Decisions
1. **Lock path**: `${NIGHTCREW_LOCK_DIR:-$NIGHTCREW_DIR/state}/.nightcrew.lock`. Env-var override exists solely for test isolation; production path is `$NIGHTCREW_DIR/state/.nightcrew.lock`. **Confidence: 9.** [Layer 1 — POSIX filesystem primitive.]
2. **Lock mechanism**: directory created via `mkdir` (atomic on POSIX). No `flock`. **Confidence: 10 — decision pre-made by user.** [Layer 1 — portable POSIX.]
3. **PID file**: `$lock_dir/pid` written with `echo $$`, read with `cat`. **Confidence: 10.** [Layer 1.]
4. **Stale detection**: `kill -0 <pid> 2>/dev/null`. If the signal check fails, the PID is gone; remove the dir and retry `mkdir` exactly once. **Confidence: 9.** [Layer 1.]
5. **Trap wiring**: `acquire_run_lock` first, then `trap release_run_lock EXIT`, keeping the existing `trap cleanup_on_signal SIGINT SIGTERM SIGHUP` line untouched. Signal handlers call `exit`, which fires the EXIT trap → release. This is the minimal-diff approach. **Confidence: 9.**
6. **Idempotent release**: `release_run_lock` runs `rm -rf "$lock_dir"` unconditionally (rm -rf on a nonexistent dir is a no-op). Safe to call multiple times, from multiple traps, in any order. **Confidence: 10.**
7. **Scope gate**: call site is inside `nightcrew_run()` only. Other subcommand handlers in `nightcrew.sh` are untouched, so `preflight`/`review`/`serve`/`sessions`/`benchmark`/`config`/`enable`/`disable`/`--version`/`--help` never touch the lock. **Confidence: 10.**
8. **No test-mode bypass**: the env-var lock-dir override is sufficient; no special `NIGHTCREW_SKIP_LOCK` flag. Tests source `lib/run-lock.sh` directly and point `NIGHTCREW_LOCK_DIR` at `TEST_TEMP_DIR`. **Confidence: 9.**
9. **Error message format**: exactly as specified: `Another nightcrew run is already in progress (PID <pid>). state/.nightcrew.lock is held.` and `Stale lock from dead PID <pid> — reclaiming.` — written to stderr via `>&2`. **Confidence: 10.**
10. **Exit code on contention**: `exit 1`. **Confidence: 10.**
11. **mkdir -p state**: use `mkdir -p "$lock_base_dir"` where `lock_base_dir` is `${NIGHTCREW_LOCK_DIR:-$NIGHTCREW_DIR/state}`. Creates the parent dir before attempting the atomic lock-dir mkdir. **Confidence: 10.**

## Implementation Steps

1. **`lib/run-lock.sh`** — NEW FILE. Contents:
   - Shebang `#!/usr/bin/env bash` (not executed, but consistent with other libs).
   - A single top-level helper that resolves the lock dir once per call: `local lock_base="${NIGHTCREW_LOCK_DIR:-${NIGHTCREW_DIR:-$(pwd)}/state}"; local lock_dir="$lock_base/.nightcrew.lock"`. Keep the resolution inlined in each function (no shared globals) so calls from tests don't require extra setup.
   - `acquire_run_lock()`:
     - Resolve `lock_base` and `lock_dir` as above.
     - `mkdir -p "$lock_base"` (create `state/` if missing).
     - First attempt: `if mkdir "$lock_dir" 2>/dev/null; then echo "$$" > "$lock_dir/pid"; return 0; fi`.
     - On first-attempt failure, read `existing_pid` from `$lock_dir/pid` (tolerate a missing file by defaulting to empty string).
     - If `existing_pid` is empty OR `! kill -0 "$existing_pid" 2>/dev/null`:
       - Emit `Stale lock from dead PID ${existing_pid:-unknown} — reclaiming.` to stderr.
       - `rm -rf "$lock_dir"`.
       - Retry exactly once: `if mkdir "$lock_dir" 2>/dev/null; then echo "$$" > "$lock_dir/pid"; return 0; fi`.
       - If the retry still fails (someone raced in), fall through to the "live holder" branch below using the freshly-re-read PID.
     - Live-holder branch (PID is alive or retry race lost): emit `Another nightcrew run is already in progress (PID $existing_pid). state/.nightcrew.lock is held.` to stderr and `exit 1`.
   - `release_run_lock()`:
     - Resolve `lock_base` and `lock_dir`.
     - `rm -rf "$lock_dir"` (suppress errors; idempotent).
     - Return 0 unconditionally.
   - **Do not** call `acquire_run_lock` at source time. **Do not** install any trap in this file — traps are owned by the caller (`nightcrew_run`) so tests can install their own.

2. **`lib/run.sh:731–736`** — EDIT (one-call insertion, one-line addition).
   - Immediately after the function opens and local vars are read (lines 732–734), BEFORE the existing `trap cleanup_on_signal` line (736):
     - Add `acquire_run_lock` call.
     - Add `trap release_run_lock EXIT` line.
   - Keep the existing `trap cleanup_on_signal SIGINT SIGTERM SIGHUP` line (736) as-is. When a signal fires, `cleanup_on_signal` ends with `exit 1`, which triggers the EXIT trap and releases the lock.
   - Net diff inside `nightcrew_run()`: two new lines.

3. **`nightcrew.sh`** — NO EDIT. The `for lib in "$NIGHTCREW_DIR"/lib/*.sh` glob at line 15 picks up the new file automatically. Verify by eye after step 1.

4. **`tests/run-lockfile.bats`** — NEW FILE.
   - `load test_helper` to get `$PROJECT_ROOT` and `$TEST_TEMP_DIR`.
   - `setup()` after the load: override the helper's setup by exporting `NIGHTCREW_LOCK_DIR="$TEST_TEMP_DIR"` so each test gets a fresh lock dir under the per-test temp dir. Also source `lib/run-lock.sh` (if not already sourced via helper — easier to source it in setup for clarity).
   - `teardown()` — rely on helper's teardown that `rm -rf`s `TEST_TEMP_DIR`.
   - Five `@test` blocks (see Test Plan below).

5. **`tests/test_helper.bash`** — EDIT. Add one line to the source block: `source "$PROJECT_ROOT/lib/run-lock.sh"` after the existing sources (around line 29, after `lib/run.sh`). This lets all tests exercise the lock functions without re-sourcing.

6. **`TODOS.md`** — EDIT.
   - Delete lines 43–47 (the "## Run Lockfile" active entry plus its trailing blank line).
   - Insert a new entry in the `## Completed` section (after line 55). Place it at the TOP of the completed list (most recent first, matching "Multi-Project Support" being first at line 57). Exact body:
     ```
     ### Run Lockfile
     **Completed:** v0.3.x (2026-04-17)
     Added mkdir-based lockfile at `state/.nightcrew.lock`. Global scope (one `nightcrew run` at a time). Stale-PID detection with automatic reclaim. Trap-based release on INT/TERM/EXIT. Five bats tests covering acquire, fail, release, stale reclaim, and SIGINT trap.
     ```

## Test Plan

```
TEST COVERAGE PLAN
===========================
[+] lib/run-lock.sh
    |
    +-- acquire_run_lock()
    |   +-- [NEED TEST 1] Fresh: mkdir succeeds, pid file written
    |   +-- [NEED TEST 2] Contention with live PID → exit 1 + stderr msg
    |   +-- [NEED TEST 4] Stale PID → warn + reclaim + succeed
    |   +-- (implicit in test 2/4) Race loss on retry → still fails cleanly
    |
    +-- release_run_lock()
    |   +-- [NEED TEST 3] Removes lock dir; re-acquire works
    |   +-- (implicit) Idempotent when dir absent (covered by test 3 re-run)
    |
    +-- trap wiring (integration with a real shell)
        +-- [NEED TEST 5] SIGINT-trapped shell releases lock on exit

------------------------------
TOTAL: 5 paths need tests
------------------------------
```

### Test specifications (each is a `@test` in `tests/run-lockfile.bats`)

**Test 1 — Fresh acquire**
- `NIGHTCREW_LOCK_DIR="$TEST_TEMP_DIR"` already exported in setup.
- `run acquire_run_lock`.
- Assert `[ "$status" -eq 0 ]`.
- Assert `[ -d "$TEST_TEMP_DIR/.nightcrew.lock" ]`.
- Assert `[ -f "$TEST_TEMP_DIR/.nightcrew.lock/pid" ]`.
- Assert the pid file content matches the bats child PID. Because `run` executes in a subshell, capture `$$` inside the run via a helper: `run bash -c 'source '"$PROJECT_ROOT"'/lib/run-lock.sh; acquire_run_lock; echo $$ > '"$TEST_TEMP_DIR"'/expected_pid; cat '"$TEST_TEMP_DIR"'/.nightcrew.lock/pid'` — then compare output lines. Simpler pattern: assert the pid file is non-empty and is numeric (`[[ "$(cat ".../pid")" =~ ^[0-9]+$ ]]`), and assert `kill -0 <that-pid> 2>/dev/null` succeeds (i.e., the PID is currently alive, which it is because it's the bats runner tree). This avoids subshell-PID confusion while still proving we wrote a real live PID.

**Test 2 — Concurrent live holder fails**
- In setup: `mkdir -p "$TEST_TEMP_DIR/.nightcrew.lock"; echo "$$" > "$TEST_TEMP_DIR/.nightcrew.lock/pid"` (bats runner PID — guaranteed alive during the test).
- `run acquire_run_lock`.
- Assert `[ "$status" -eq 1 ]`.
- Assert `[[ "$output" == *"Another nightcrew run is already in progress"* ]]`.
- Assert the pid number appears in stderr: `[[ "$output" == *"(PID $$)"* ]]`.
- Assert lock dir still exists and still holds our seeded PID (acquire must NOT delete a live holder's lock).

**Test 3 — Release frees the lock**
- `acquire_run_lock` (direct call — not via `run`, because we want the state in the current shell).
- Assert lock dir exists.
- `release_run_lock`.
- Assert `[ ! -e "$TEST_TEMP_DIR/.nightcrew.lock" ]`.
- `acquire_run_lock` again (direct).
- Assert lock dir exists again (re-acquisition succeeded).
- Call `release_run_lock` twice back-to-back — second call must return 0 (idempotency).

**Test 4 — Stale reclaim**
- Capture a dead PID from an exited subshell: `dead_pid=$(bash -c 'echo $$')`. By the time the next command runs, that PID is dead (verify with `! kill -0 "$dead_pid" 2>/dev/null` as a guard; if the guard fails, `skip` the test — extremely rare on a loaded system).
- `mkdir -p "$TEST_TEMP_DIR/.nightcrew.lock"; echo "$dead_pid" > "$TEST_TEMP_DIR/.nightcrew.lock/pid"`.
- `run acquire_run_lock`.
- Assert `[ "$status" -eq 0 ]`.
- Assert `[[ "$output" == *"Stale lock from dead PID $dead_pid"* ]]`.
- Assert `[[ "$output" == *"reclaiming"* ]]`.
- Assert the new pid file contains a live PID (not `$dead_pid`).

**Test 5 — Trap releases on SIGINT**
- Write a small inline script file into `$TEST_TEMP_DIR/holder.sh`:
  ```
  #!/usr/bin/env bash
  source "$1/lib/run-lock.sh"
  trap 'release_run_lock; exit 130' INT TERM
  trap release_run_lock EXIT
  acquire_run_lock
  echo "ready" > "$2/ready"
  sleep 30
  ```
- Launch: `NIGHTCREW_LOCK_DIR="$TEST_TEMP_DIR" bash "$TEST_TEMP_DIR/holder.sh" "$PROJECT_ROOT" "$TEST_TEMP_DIR" &` and capture `holder_pid=$!`.
- Wait up to 5 seconds for `$TEST_TEMP_DIR/ready` to exist (poll loop, `sleep 0.1`). If it never appears, `kill "$holder_pid"` and fail the test with a diagnostic.
- Assert `[ -d "$TEST_TEMP_DIR/.nightcrew.lock" ]` (lock held while holder is sleeping).
- `kill -INT "$holder_pid"`.
- `wait "$holder_pid" || true` (collect the exit code — SIGINT exit is expected).
- Assert `[ ! -e "$TEST_TEMP_DIR/.nightcrew.lock" ]` — the trap ran.

### Parity check on existing suites
No existing `.bats` file invokes `nightcrew.sh run` (grep confirmed zero matches). Adding the lock to `nightcrew_run()` cannot regress any existing test. `tests/cli-commands.bats` only exercises `--version`, `enable`, `disable`, `sessions` — all outside the lock scope. No test-mode bypass needed.

## Failure Modes

| Codepath | Failure scenario | Test covers? | Error handling? | What the user sees |
|---|---|---|---|---|
| `mkdir "$lock_dir"` first attempt | Disk full / perms denied on `state/` | No (out of scope for lock logic) | `mkdir -p` error bubbles via `set -e` in nightcrew.sh | Stderr: raw mkdir error, then `set -e` aborts `nightcrew run`. Acceptable — surfaces real filesystem problem loudly. |
| `echo $$ > "$lock_dir/pid"` | Write fails after mkdir succeeded (disk full mid-op) | No | Under `set -e`, the write failure exits the run. EXIT trap fires → `release_run_lock` cleans up the half-written lock dir. | Stderr: write error; run aborts. Lock dir cleaned up by EXIT trap. User can retry. |
| Second `mkdir` racing another nightcrew instance that reclaimed a stale lock 1ms earlier | Retry `mkdir` fails because another process just claimed it | Yes (test 2 covers the "still held" case; retry-race falls through to the same live-holder branch) | Yes — falls through to live-holder error | Stderr: `Another nightcrew run is already in progress (PID <new-holder>)`. Exit 1. Clear. |
| Missing `$lock_dir/pid` file (lock dir created by third party, or prior write failed) | `cat` fails, `existing_pid` is empty | Implicitly by test 4 branch when pid is empty | Yes — empty PID takes the stale-reclaim path (treated as dead) | Stderr: `Stale lock from dead PID unknown — reclaiming.` Acceptable. |
| SIGKILL (9) to `nightcrew run` | Traps do not fire; lock dir remains with a now-dead PID | Yes (test 4 — stale detection catches it on next run) | Yes — next acquire reclaims | First next run emits `Stale lock from dead PID <pid> — reclaiming.` and succeeds. User sees one informational warning line. |
| `release_run_lock` called with lock dir already gone | `rm -rf` no-op | Yes (test 3 double-release) | Yes — idempotent | Silent. Correct. |
| PID reallocation race (dead PID gets reused between `kill -0` check and our retry) | We think it's stale, we `rm -rf`, but the NEW owner of that PID is an unrelated process | Not tested (race is milliseconds on reused PID, harmless to unrelated process) | Partial — we only ever remove OUR lock dir; we never signal the PID. The unrelated process is unaffected. | Silent — the unrelated process isn't touched; a new nightcrew run proceeds. Acceptable — no user-visible failure. |
| Non-`run` subcommand (e.g., `nightcrew review`) invoked while a run holds the lock | Review reads `state/progress.json` concurrently with the running write | Not in scope (explicitly per requirement #6) | None | User sees partial data in review. Pre-existing behavior, unchanged by this patch. |

No critical gaps: every silent/crash failure mode either has a test or is self-healing on next run.

## NOT In Scope
- `flock`-based locking — explicitly ruled out; macOS does not ship `flock`.
- Per-project / per-`.worktrees/` locks — explicitly overruled by requirement #5.
- Blocking/retrying with timeout — explicitly ruled out; fail-fast only.
- Locking on `preflight`, `review`, `serve`, `sessions`, `benchmark`, `config`, `enable`, `disable`, `--version`, `--help` — explicitly excluded by requirement #6.
- Test-mode bypass env var (e.g., `NIGHTCREW_SKIP_LOCK`) — unnecessary because tests use `NIGHTCREW_LOCK_DIR` to sandbox per-test lock dirs.
- `CHANGELOG.md` update — not listed in files in scope.
- `VERSION` bump — not listed in files in scope. TODOS.md entry uses `v0.3.x` placeholder per the task text.
- Refactoring `cleanup_on_signal` in `lib/run.sh` — the minimal diff keeps the existing trap line untouched and adds a separate EXIT trap beside it.
- Holding the lock during `nightcrew review` of a live session — intentionally excluded; review is read-mostly and the user may well want to peek during a running session.

## Decisions Log

1. **Lock dir anchor** — Chose `$NIGHTCREW_DIR/state/.nightcrew.lock` (absolute, anchored to the nightcrew install). Alternative: `$(pwd)/state/.nightcrew.lock` (cwd-relative, matches the literal text in requirements). Chose NIGHTCREW_DIR anchoring because every other state path in the codebase uses it (`lib/state.sh:111`, `lib/review.sh:7`). Running `nightcrew run` from different cwds must produce the same lock, otherwise the "global scope" guarantee (requirement #5) breaks. Added `NIGHTCREW_LOCK_DIR` env override purely for test sandboxing.
2. **Trap strategy** — Chose to add a separate `trap release_run_lock EXIT` next to the existing `trap cleanup_on_signal SIGINT SIGTERM SIGHUP`. Alternative: merge into one combined handler. Chose separation because (a) EXIT fires on every exit path including errors under `set -e`, signal handlers that `exit`, and normal completion, so a single EXIT trap covers all cases; (b) it leaves `cleanup_on_signal` untouched — zero refactor risk; (c) `release_run_lock` is idempotent, so double-invocation is safe.
3. **Stale detection primitive** — Chose `kill -0 $pid`. Alternatives: `ps -p $pid`, checking `/proc/$pid` (Linux-only, non-portable). `kill -0` is POSIX, works on macOS and Linux, is exactly what the requirement text specified.
4. **Retry count** — Chose exactly one retry after stale reclaim. Alternative: loop until success. Chose one because the retry race window is microseconds and a double-loss means a real live contender — correctly surfacing a contention error is better than a loop.
5. **Error stream** — Chose stderr (`>&2`) for both contention and stale-warn messages. Matches requirement #2 and #3 verbatim.
6. **Test source strategy** — Chose to add `source "$PROJECT_ROOT/lib/run-lock.sh"` to `tests/test_helper.bash` rather than re-source per test. Alternative: source in each test's setup. Chose helper-level because every `.bats` file already loads the helper and this mirrors the existing pattern of sourcing other libs there (`lib/00-common.sh`, `lib/state.sh`, etc.).
7. **Test 1 PID assertion** — Chose to verify the pid file contains a live, numeric PID rather than asserting an exact match to `$$`. Alternative: `$$` comparison. Chose liveness-check because `bats run` executes in a subshell and `$$` inside the subshell differs from the outer test's `$$`, which makes an exact comparison confusing. Liveness + numericness proves the semantics without flakiness.
8. **Test 4 dead-PID source** — Chose `dead_pid=$(bash -c 'echo $$')` per requirement. Alternative: hardcoded `99999`. Hardcoded PIDs are unsafe on Linux (pid_max >> 99999 by default); subshell approach is portable.
9. **Test 5 holder script** — Chose writing a temp `holder.sh` and launching it in the background. Alternative: background a heredoc via `bash -c`. A standalone file is easier to read and debug if the test fails, and avoids heredoc quoting hell.
10. **TODOS.md placement** — Chose to insert the new Completed entry at the TOP of `## Completed` (newest-first), matching the existing ordering where "Multi-Project Support" (v0.3.2) is listed before older v0.2.0 entries.
