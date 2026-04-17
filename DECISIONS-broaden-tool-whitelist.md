# Decisions: Broaden default tool whitelist

## Plan

Files to change (in order):
1. `lib/tool-router.sh` — update header diagram, expand `test` and `implementation|refactor` arms
2. `tests/tool-routing.bats` (new) — 6 bats test cases
3. `TODOS.md` — move active entry to Completed

## Decision: Single shared whitelist string for test and implementation|refactor

**What:** Both `test` and `implementation|refactor` emit the same literal tool string.
**Why:** The task brief explicitly requires identical lists; literal duplication makes the diff minimal and the intent obvious without hiding anything in a shared variable.
**Alternatives considered:** A shared variable (e.g. `COMMON_TOOLS`) referenced from both arms; a single `test|implementation|refactor` case with fallthrough.
**Risk:** A typo in one arm won't automatically propagate to the other. Mitigated by the byte-equality bats test (case b) which compares `implementation` vs `refactor`, and by the token-presence tests for `test` (case c).

## Decision: Drop Bash(npx tsc*) from impl/refactor arm

**What:** The expanded list uses `Bash(npx*)` only (not the redundant `Bash(npx tsc*)` that was in the original).
**Why:** `Bash(npx*)` is a superset — it subsumes `Bash(npx tsc*)`. The task brief's target whitelist lists only `Bash(npx*)`. Removing the redundant pattern makes the string shorter and follows the brief verbatim.
**Alternatives considered:** Keeping both for backward compat.
**Risk:** Any task that relied on the exact pattern string `npx tsc*` literally will still match via `npx*`. No regression.

## Decision: New file tests/tool-routing.bats (not extending routing.bats)

**What:** Created a new dedicated bats file rather than appending to `tests/routing.bats`.
**Why:** `routing.bats` already mixes model and tool tests with its own `setup`/`teardown`. A new file keeps ownership clear and avoids bloating the existing file. The task brief prefers a new file.
**Alternatives considered:** Appending to routing.bats.
**Risk:** Minor test-file proliferation. Acceptable.

## Decision: No change to test_helper.bash

**What:** `lib/tool-router.sh` is already sourced at line 27 of `test_helper.bash`. No edit needed.
**Why:** The new bats file uses `load test_helper` which pulls in the existing source line.
**Risk:** None.

## Summary

All four files changed as planned. The `test` and `implementation|refactor` whitelists now include `git mv`, `git rm`, `bats`, and read-side shell helpers (`test`, `grep`, `ls`, `cat`, `find`, `wc`). `research` is unchanged. Custom override block is intact. 6 new bats tests cover all required cases. TODOS.md entry moved to Completed.
