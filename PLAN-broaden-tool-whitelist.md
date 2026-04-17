# Implementation Plan: Broaden default tool whitelist for implementation/refactor/test tasks

## Scope Decision
Expand the default `allowedTools` whitelist inside `lib/tool-router.sh` for the `test` and `implementation|refactor` cases so realistic file-level refactors and test-authoring tasks can run without a per-task `allowed_tools` override. The `research` case stays read-only. The custom-override block stays intact. A new `tests/tool-routing.bats` covers the six required cases; `tests/routing.bats` keeps its existing shallow tool-routing tests as-is (no deletion, no overlap pruning). `TODOS.md` gets the entry moved to `## Completed`. Explicitly excluded: splitting the whitelist by verb (task description option (c)), introducing a new task type like `filesystem-refactor` (option (b)), any version bump in `VERSION`, any touches to other libs, CHANGELOG edits, or drive-by cleanup in `routing.bats`.

## What Already Exists
- `lib/tool-router.sh:13-37` — the `route_tools` function with four cases (`research`, `test`, `implementation|refactor`, `*`) and the custom-override block. Plan **extends** the two cases and their ASCII diagram row.
- `lib/tool-router.sh:17-21` — the `if [[ -n "$custom_tools" ]]` precedence block. Plan **preserves** byte-for-byte.
- `tests/routing.bats:79-130` — shallow tool-routing coverage (membership checks, impl==refactor equality, custom-override precedence, unknown-type fallback). Plan **does not modify** this file. The new `tests/tool-routing.bats` adds strict byte-equality and full-token-presence assertions that go beyond the existing file; minor substring duplication is acceptable and preferable to refactoring a passing test file out of scope.
- `tests/test_helper.bash:27` — already sources `lib/tool-router.sh`. Plan **reuses** it; no edit needed to `test_helper.bash`.
- `TODOS.md:38-42` (active entry) and `TODOS.md:52-64` (existing `## Completed` format with `### Title` + `**Completed:** vX.Y.Z (YYYY-MM-DD)` + short paragraph). Plan **matches** the existing completed-entry format.

## Architecture Decisions
1. **Keep a single shared list for `test` and `implementation|refactor`.** The task brief says extend both to the same expanded list. Collapsing them into one fallthrough is tempting but risks hiding intent; instead, emit the same literal string from both arms. Rationale: explicit over clever; diff minimal; byte-equality test #2 still passes because the two arms share the `implementation|refactor)` label, and test #3 checks `test` independently. Confidence: 10/10 — verified against `lib/tool-router.sh:27-32`.
2. **Drop `Bash(npx tsc*)` from the impl/refactor arm in favor of only `Bash(npx*)`.** The task-supplied target whitelist lists `Bash(npx*)` and omits `Bash(npx tsc*)`; `Bash(npx*)` subsumes it. Rationale: follow the brief verbatim and minimize redundant patterns. Confidence: 10/10.
3. **New file `tests/tool-routing.bats`, not extend `routing.bats`.** Task brief prefers a new file; `routing.bats` mixes model + tool tests and I don't want to bloat it. Rationale: minimal diff, clear ownership. Confidence: 9/10.
4. **Use `load test_helper` in the new bats file** (same pattern as `routing.bats:4`). No new source lines in `test_helper.bash` because `lib/tool-router.sh` is already sourced at `test_helper.bash:27`. Confidence: 10/10 — verified.
5. **Byte-for-byte equality tests use `[ "$a" = "$b" ]`.** Bats idiom already used in `routing.bats:111`. Confidence: 10/10.
6. **Research read-only test asserts `Write`, `Edit`, `git add`, `rm` are all absent** via four `[[ "$output" != *"…"* ]]` checks. The literal `rm` is a substring check — `research` currently returns `Read,Grep,Glob,Bash(curl -s*)` which contains no `rm`, so the assertion holds. Rationale: brief explicitly requires it. Confidence: 10/10.
7. **ASCII-diagram row wording** — keep the table structure (lines 4-11) and rewrite the right-hand column for `test`, `implementation`, `refactor` to something like `Read/write + git (incl. mv/rm) + test runners + shell helpers`. Keep `research` row unchanged. Rationale: brief says "keep the table format; update the allowedTools column content." Confidence: 9/10.
8. **TODOS.md — leave the `## Completed` section's current header intact** and prepend the new completed entry above `### Promote DESIGN.md to Project Root` (the newest completed entry, also dated 2026-04-17). Rationale: keeps newest-first ordering visible in the section. Confidence: 7/10 — the file doesn't enforce a strict ordering convention; either position is fine. Going with "newest at top of Completed" since `### Promote DESIGN.md` and `### Run Lockfile` are both `v0.3.x (2026-04-17)` and already appear at the top of the section.
9. **No `VERSION` bump, no `CHANGELOG.md` entry.** The brief says "Leave version as `v0.3.x` for whoever bumps." Rationale: follow the brief; /ship handles version bumps. Confidence: 10/10.
10. **Test count in TODOS.md text** — the brief template says "N new bats tests". Replace `N` with `6` (one per required case). Confidence: 10/10.

## Implementation Steps

1. **`lib/tool-router.sh`** — update the header diagram (lines 4-11) and the two case arms.
   - Replace the `test` row and `implementation`/`refactor` rows in the ASCII diagram so the right column reads, for each: `Read/write + git (incl. mv/rm) + test runners + shell helpers`. Keep the `research` row exactly as-is. Preserve the Unicode box-drawing characters and overall table width.
   - Replace line 28 (the `test)` arm body) with a single `echo` of:
     `Read,Grep,Glob,Write,Edit,Bash(git add*),Bash(git commit*),Bash(git diff*),Bash(git status*),Bash(git log*),Bash(git mv*),Bash(git rm*),Bash(npm test*),Bash(npx*),Bash(bun test*),Bash(pytest*),Bash(go test*),Bash(bats*),Bash(mkdir*),Bash(test*),Bash(grep*),Bash(ls*),Bash(cat*),Bash(find*),Bash(wc*)`
   - Replace line 31 (the `implementation|refactor)` arm body) with the **exact same** string as the `test` arm above (byte-for-byte).
   - Do NOT modify lines 13-22 (function signature, `custom_tools` override block, case opener).
   - Do NOT modify line 25 (research arm).
   - Do NOT modify lines 33-36 (generic fallback arm).
   - Keep the closing `esac` and `}` unchanged.

2. **`tests/tool-routing.bats`** — create new file.
   - Shebang `#!/usr/bin/env bats`.
   - `load test_helper`.
   - Do NOT redefine `setup`/`teardown` — the helper provides them.
   - Define six `@test` blocks matching the six brief cases:
     - (a) `implementation default whitelist includes all required tokens` — call `route_tools implementation`, assert `[[ "$output" == *"$tok"* ]]` for each of: `Read`, `Grep`, `Glob`, `Write`, `Edit`, `git add*`, `git commit*`, `git diff*`, `git status*`, `git log*`, `git mv*`, `git rm*`, `npm test*`, `npx*`, `bun test*`, `pytest*`, `go test*`, `bats*`, `mkdir*`, `test*`, `grep*`, `ls*`, `cat*`, `find*`, `wc*`.
     - (b) `refactor default whitelist equals implementation byte-for-byte` — capture both into locals with command substitution, assert `[ "$impl" = "$refactor" ]`.
     - (c) `test default whitelist includes expanded tokens` — call `route_tools test`, assert the same token list as (a).
     - (d) `research default whitelist stays narrow and read-only` — call `route_tools research`, assert presence of `Read`, `Grep`, `Glob`, `curl`; assert absence of `Write`, `Edit`, `git add`, and `rm` via `[[ "$output" != *"…"* ]]`.
     - (e) `custom tools override wins for implementation` — `run route_tools implementation "Read,Bash(echo*)"`, assert `[ "$output" = "Read,Bash(echo*)" ]`.
     - (f) `unknown task type falls back to generic whitelist` — `run route_tools unknown_type`, assert exact equality with the current generic string: `Read,Grep,Glob,Write,Edit,Bash(git add*),Bash(git commit*),Bash(git diff*),Bash(git status*),Bash(git log*)`.
   - Use `run route_tools …` + `[[ "$output" == … ]]` idioms already present in `tests/routing.bats`.

3. **`tests/test_helper.bash`** — no change required. Verify by reading line 27 (`source "$PROJECT_ROOT/lib/tool-router.sh"`). Confirm and move on.

4. **`TODOS.md`** — move the active entry to `## Completed`.
   - Delete lines 38-42 (the `## Broaden default tool whitelist for implementation/refactor tasks` block, including its trailing blank line so the next active section flows cleanly).
   - Insert the following block in the `## Completed` section, immediately after the `## Completed` header line (line 52), making it the newest entry:
     ```
     ### Broaden default tool whitelist
     **Completed:** v0.3.x (2026-04-17)
     Expanded `implementation`, `refactor`, and `test` default tool whitelists in `lib/tool-router.sh` to include `git mv`, `git rm`, `bats`, and read-side shell helpers (`test`, `grep`, `ls`, `cat`, `find`, `wc`). `research` stays narrow. Custom overrides still take precedence. 6 new bats tests in `tests/tool-routing.bats`.
     ```
   - Do NOT renumber or reorder any other active/completed entries.
   - Do NOT touch the `## Preflight gitignore` entry below it.

## Test Plan

```
TEST COVERAGE PLAN
===========================
[+] lib/tool-router.sh :: route_tools()
    |
    +-- custom_tools override branch (lines 17-21)
    |   +-- [COVERED by new (e)] non-empty custom_tools wins for "implementation"
    |   +-- [COVERED existing] routing.bats "custom tools override defaults" (research + custom)
    |   +-- [COVERED existing] routing.bats "empty custom tools string uses defaults"
    |
    +-- case "research"
    |   +-- [COVERED by new (d)] full-string assertion: Read/Grep/Glob/curl present; Write/Edit/git add/rm absent
    |
    +-- case "test"
    |   +-- [COVERED by new (c)] all 25 expanded tokens present (includes the 9 new: git mv/rm, bats, mkdir, test*, grep*, ls*, cat*, find*, wc*)
    |
    +-- case "implementation|refactor"
    |   +-- [COVERED by new (a)] all 25 expanded tokens present for "implementation"
    |   +-- [COVERED by new (b)] byte-equality impl vs refactor
    |   +-- [COVERED existing] routing.bats "refactor type gets same tools as implementation"
    |
    +-- case "*" (generic fallback)
        +-- [COVERED by new (f)] exact-string match for unknown task type

------------------------------
TOTAL: 6 new bats cases, all passing against the updated whitelist
------------------------------
```

Specific tests to write (all in `tests/tool-routing.bats`, following `tests/routing.bats:79-130` style):

| # | Test name | Assertion style | Expected |
|---|-----------|-----------------|----------|
| a | `implementation default whitelist includes all required tokens` | substring present (`[[ "$output" == *"tok"* ]]`) × 25 tokens | all present |
| b | `refactor default whitelist equals implementation byte-for-byte` | `[ "$impl" = "$refactor" ]` | equal |
| c | `test default whitelist includes expanded tokens` | substring present × 25 tokens | all present |
| d | `research default whitelist stays narrow and read-only` | 4 present + 4 absent substring checks | as specified |
| e | `custom tools override wins for implementation` | exact equality | `Read,Bash(echo*)` |
| f | `unknown task type falls back to generic whitelist` | exact equality | `Read,Grep,Glob,Write,Edit,Bash(git add*),Bash(git commit*),Bash(git diff*),Bash(git status*),Bash(git log*)` |

Existing `tests/routing.bats` tests (lines 79-130) stay untouched and continue to pass because the expanded whitelists are strict supersets of the substrings those tests check for.

## Failure Modes

| Codepath | Realistic failure | Test covers it? | Error handling exists? | What the user sees |
|---|---|---|---|---|
| `route_tools implementation` emits malformed string (typo, missing comma) | New bats tests (a/b) assert each expected token; a missing comma would glue two together and the substring check still passes but byte-equality in (b) would still match impl vs refactor. Risk: a typo that appears in **both** arms (because we copy-paste the same string) would pass (a), (b), AND (c). | Partially — (a) and (c) verify tokens by substring, not structure. A stray space inside `Bash(git mv*)` → `Bash( git mv*)` would evade substring checks. | No runtime validation in `route_tools` itself. | Silent: Claude CLI receives the malformed `--allowed-tools` string and may reject the exact pattern at invocation time, printing `Error: invalid tool pattern` — recoverable and visible. |
| `route_tools research` accidentally broadened (regression) | Test (d) explicitly asserts `Write`, `Edit`, `git add`, `rm` are absent. | Yes. | N/A — assertion-level enforcement. | Test suite fails in CI — clear failure. |
| Custom override stops being honored (regression on lines 17-21) | Test (e) asserts exact equality. | Yes. | N/A. | Test suite fails in CI. |
| Fallback case `*` accidentally changed | Test (f) asserts exact string. | Yes. | N/A. | Test suite fails in CI. |
| `tests/tool-routing.bats` can't find `route_tools` | Would mean `test_helper.bash` stopped sourcing `lib/tool-router.sh`. | Every test would fail with `route_tools: command not found`. | No. | Bats reports `command not found` — clear, actionable. |
| TODOS.md malformed after move (stray blank line, duplicate entry, or active entry not removed) | No automated test. | No. | No. | Reviewer catches in PR review — cosmetic, non-blocking. |

No **critical gap** identified (nothing silent + crash-inducing + untested). The token-typo scenario is the weakest link; accept it — over-engineering a string-schema test for a shell case statement isn't warranted.

## NOT In Scope

- **Option (b) — new `filesystem-refactor` task type.** Brief picks option (a); don't speculatively add a new type.
- **Option (c) — verb-based whitelist composition (git-ops, test-runners, read-helpers).** Same reason; would expand the diff and require schema changes.
- **`VERSION` bump and `CHANGELOG.md` entry.** Brief says leave as `v0.3.x`; /ship handles it.
- **Pruning overlap between `tests/routing.bats` (lines 79-130) and the new `tests/tool-routing.bats`.** Drive-by refactor; keep `routing.bats` untouched.
- **Shell-level validation inside `route_tools`** (e.g., verifying the emitted string parses as a valid Claude CLI pattern). Overengineering for a case statement.
- **Docs sync** — `README.md`, `DESIGN.md`, `docs/` are out of scope. The header ASCII table inside `lib/tool-router.sh` is the canonical documentation for this module.
- **Other libs** (`lib/model-router.sh`, `lib/run.sh`, `lib/validate.sh`, etc.) — brief restricts scope.

## Decisions Log

1. **Broaden per brief vs. split whitelist by verb (option c).** Chose broaden. Rationale: brief is explicit; option (c) is larger-surface and speculative.
2. **New file `tests/tool-routing.bats` vs. extend `tests/routing.bats`.** Chose new file. Rationale: brief prefers new file; keeps model and tool coverage separate; minimal-diff to existing passing tests.
3. **Do not source `lib/tool-router.sh` again in the new bats file.** Rationale: `test_helper.bash:27` already sources it; double-sourcing would be redundant.
4. **Byte-equality test for impl vs refactor.** Chose strict `[ "$a" = "$b" ]`. Rationale: brief says "byte-for-byte equality"; substring checks would miss reordering.
5. **Exact-string equality for the fallback `*` case.** Chose `[ "$output" = "Read,Grep,Glob,Write,Edit,Bash(git add*)…" ]` (the current literal). Rationale: brief says "unchanged"; exact match catches regressions that substring checks miss.
6. **Research test: include `rm` absence.** Kept per brief, even though current research output already excludes `rm`. Rationale: guards against future drift.
7. **New completed-entry position in `TODOS.md`.** Top of `## Completed` (above `### Promote DESIGN.md`). Rationale: matches the newest-first pattern already visible in the section; reviewer expectation alignment.
8. **Test count `N=6`.** Rationale: one test per brief case; fills in the `N` placeholder unambiguously.
9. **ASCII diagram phrasing.** Chose `Read/write + git (incl. mv/rm) + test runners + shell helpers` for test/implementation/refactor rows. Rationale: keeps column width manageable; signals the three new capability clusters; research row stays untouched.
10. **No `Bash(npx tsc*)` in the new impl/refactor arm.** Dropped because `Bash(npx*)` subsumes it and the brief's target string omits it. Rationale: follow the brief; avoid redundant patterns.
