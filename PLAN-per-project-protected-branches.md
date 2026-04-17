# Implementation Plan: Per-project protected_branches override on tasks

## Scope Decision
Add `protected_branches` (optional string array) to `schemas/task.schema.json`. Extend `is_protected_branch()` in `lib/00-common.sh` with an optional third arg (`extra_branches`) that's unioned with the global list. Parse the per-task list in the `lib/run.sh` task loop and pass it through at the one existing call site (`lib/run.sh:855`). Add `tests/protected-branches.bats` with six cases. Update `README.md` (Multi-Project Support block) and `tasks.yaml.example` with one-line snippets. Move the TODOS.md entry to Completed. Explicitly excluded: CLI flag, env var, alternate config location, `config.yaml`-side projects block, `validate.sh`/preflight-side early rejection for per-task protected branches, changes to `lib/git-ops.sh` / `tests/git-ops.bats` (neither touches `is_protected_branch`), CHANGELOG/VERSION edits.

## What Already Exists
- **`lib/00-common.sh:32-39` `is_protected_branch()`** — 2-arg form reads `yq e '.protected_branches[]' config.yaml`, with hard-coded fallback `main\nmaster\ndevelop` when yq fails. **Extend** — keep the 2-arg form behavior identical (no regressions) and add optional 3rd arg for the per-task list.
- **`lib/run.sh:731-905` `nightcrew_run()`** — already parses all per-task fields from YAML via `yq e ".tasks[$i].<field>"` (lines 786–804). Pattern used for `task_project_path`, `task_depends_on`, `task_enabled`. **Reuse** — add one more `yq` call for `.protected_branches` following the same shape, then pass through to the call site at line 855.
- **`lib/run.sh:855-860`** — sole caller of `is_protected_branch`. Already inside the per-task loop and has access to `task_id`, `task_branch`, `config_file`. **Extend** — convert to 3-arg invocation with the task's list.
- **`schemas/task.schema.json:14-91`** — task object with `"required": ["id", "title", "branch", "type", "prompt"]` and `"additionalProperties": false`. Every optional field is declared as a property. **Extend** — add `protected_branches` as a sibling optional property (does not appear in `required`).
- **`tests/test_helper.bash:10-29`** — sets `PROJECT_ROOT`, creates `TEST_TEMP_DIR` in `setup()`, sources `lib/00-common.sh`. **Reuse as-is** — new bats file just does `load test_helper`, no changes needed to the helper.
- **`tests/schema.bats:97-147`** — pattern for "optional field accepted" schema tests (enabled, project_path). **Mirror** — consider one additional case here, but spec does NOT require it; keep scope to the new bats file.
- **`nightcrew.sh:14-18`** — sources every `lib/*.sh` via glob. **No change** — no new lib file to source.
- **`lib/git-ops.sh`** — never calls `is_protected_branch` (verified via grep). **No change** despite being listed in Files In Scope.

## Architecture Decisions
1. **Union semantics, not override.** Per-task `protected_branches` ADDS to the global list; it cannot remove a globally-protected branch. Enforces "never weaken global protection". **Confidence: 10** — spec locked. [Layer 1 — set union via `sort -u`.]
2. **Optional third arg with empty-string default.** `is_protected_branch()` keeps its current signature backward-compatible: `branch`, `config_file`, and new `extra_branches="${3:-}"`. Two-arg callers pass nothing; `extra_branches=""` produces identical behavior to today. **Confidence: 10.** [Layer 1 — bash positional default.]
3. **Newline-separated `extra_branches`.** Match the output shape of `yq e '.protected_branches[]'` so the three callers (global yq, task yq, final union) concatenate cleanly via `printf '%s\n%s\n'`. Accepting space-separated would break branches with `/` and force custom tokenization. **Confidence: 9.** [Layer 1.]
4. **`awk 'NF' | sort -u` for union.** Filters blank lines (both lists may be empty) and de-dups (user may list `main` in both). Avoids bashisms, works on macOS/Linux. **Confidence: 9.** [Layer 1 — POSIX text tools.]
5. **Fallback preserved.** When `yq` fails on a missing/broken config, `is_protected_branch` still falls back to `main\nmaster\ndevelop`. Do not delete or alter the fallback branch of the yq expression. **Confidence: 10** — regression guard.
6. **Fetch per-task list once per iteration.** In `lib/run.sh` inside the `for i` loop, add one `yq` call next to the existing per-task parses (near line 804). Do not refetch inside the `is_protected_branch` call. **Confidence: 10.**
7. **yq expression shape.** `yq e ".tasks[$i].protected_branches[]? // \"\"" "$tasks_file"` — the `[]?` tolerates a missing key, returns empty for absent/null; newline-separated output when present. **Confidence: 8** — will verify tolerance of missing key during test case 1 (global only).
8. **Schema placement.** Insert `protected_branches` between `project_path` (line 80–83) and `retry_strategy` (line 84–89). Matches spec; keeps related multi-project fields adjacent in the JSON schema. **Confidence: 10.**
9. **`additionalProperties: false` preserved.** Schema already enforces this — we add the field as a known property so tasks that declare it parse cleanly. Without the schema update, preflight_validate's schema check would reject any task using the new field. **Confidence: 10.**
10. **No preflight changes.** Per-task `protected_branches` is a safety ADDITION. Task will fail at runtime with `mark_task "failed" "$task_id" "protected branch"` — same path as today. No new preflight rejection needed. **Confidence: 9** — earlier detection would be nice-to-have, but scope discipline wins.
11. **No validate.sh changes.** `lib/validate.sh` does not touch branch protection today; keep it that way. **Confidence: 10.**
12. **No server.js / dashboard changes.** Dashboard shows task status, not branch-protection logic. Per-task `protected_branches` is a silent safety knob; UI doesn't need to surface it. **Confidence: 9.**
13. **No TODOS.md side additions.** Only move the existing entry to Completed with the prescribed format; no drive-by edits to other entries. **Confidence: 10.**
14. **README location: edit line 203 only.** The existing paragraph explicitly says "The `protected_branches` list applies to all projects." — replace that sentence with the new 2–3 line guidance + snippet. Keeps the edit surgical. **Confidence: 9.**
15. **tasks.yaml.example: add comment under `admin-endpoints-tests` only.** One commented line so users see the field without it being active. **Confidence: 10.**

## Implementation Steps

1. **`schemas/task.schema.json`** — insert new optional property between `project_path` and `retry_strategy`.
   - After the `project_path` block ending at line 83 (closing `}`), add a comma and this block (4-space indent to match the file):
     ```
     "protected_branches": {
       "type": "array",
       "items": { "type": "string" },
       "description": "Optional per-task list of branches NightCrew must never checkout or push to. Merged (union) with config.yaml protected_branches."
     },
     ```
   - Confirm `"additionalProperties": false` at line 91 remains unchanged.
   - Confirm `"required"` array at line 13 does NOT gain `protected_branches`.

2. **`lib/00-common.sh:31-39`** — extend `is_protected_branch` to 3-arg form with union logic.
   - Keep comment at line 31.
   - Replace body at lines 32–39 with:
     ```bash
     is_protected_branch() {
       local branch="$1"
       local config_file="${2:-./config.yaml}"
       local extra_branches="${3:-}"

       local global_protected task_protected all_protected
       global_protected=$(yq e '.protected_branches[]' "$config_file" 2>/dev/null || echo -e "main\nmaster\ndevelop")
       task_protected="$extra_branches"
       all_protected=$(printf '%s\n%s\n' "$global_protected" "$task_protected" | awk 'NF' | sort -u)
       echo "$all_protected" | grep -qx "$branch"
     }
     ```
   - Do not touch `config_get`, `log`, `log_error`, or the `timeout` fallback below.

3. **`lib/run.sh:803-805`** — parse per-task `protected_branches` once per iteration.
   - After the `task_project_path` block (line 803–804), insert:
     ```bash
     local task_protected_branches
     task_protected_branches=$(yq e ".tasks[$i].protected_branches[]?" "$tasks_file" 2>/dev/null)
     ```
   - Use `[]?` (not `[]`) so a missing key returns empty cleanly. Do not default-quote to `"null"` — yq's `[]?` yields empty string for absent arrays.

4. **`lib/run.sh:855`** — update the sole `is_protected_branch` call site to pass the per-task list.
   - Change:
     ```bash
     if is_protected_branch "$task_branch" "$config_file"; then
     ```
     to:
     ```bash
     if is_protected_branch "$task_branch" "$config_file" "$task_protected_branches"; then
     ```
   - Surrounding error-handling block (lines 856–860) stays unchanged.

5. **`tests/protected-branches.bats`** — NEW FILE. Source `lib/00-common.sh` via `load test_helper`. Six cases described in Test Plan below. Structure mirrors `tests/git-ops.bats` (per-test temp dir, focused assertions).

6. **`README.md:203`** — extend the Multi-Project Support closing paragraph.
   - Replace the single sentence "The `protected_branches` list applies to all projects." with:
     ```
     Each task may also declare its own `protected_branches` array to add repo-specific protections (the per-task list is merged with the global list, never replacing it):
     ```yaml
         protected_branches: [production]
     ```
     ```
   - Keep the existing paragraph's lead-in ("Each task creates its worktree…"), only swap the trailing sentence.

7. **`tasks.yaml.example:33`** — add a commented example field.
   - Inside the `admin-endpoints-tests` task, under `test_command:` (line 33), add:
     ```
         # Per-task protected branches (merged with config.yaml list; never removes global protection)
         # protected_branches: [production]
     ```
   - 4-space indentation consistent with existing task fields.

8. **`TODOS.md`** — move the entry.
   - Delete lines 9–13 (the active `## Per-Project Protected Branches` block).
   - Insert as the FIRST entry under `## Completed` (before line 54's `### Promote DESIGN.md to Project Root`), using the exact format:
     ```
     ### Per-Project Protected Branches
     **Completed:** v0.3.x (2026-04-17)
     Added optional `protected_branches` field to task schema. `is_protected_branch()` now accepts a third argument (per-task list, newline-separated); the union of global + per-task is checked. README.md and tasks.yaml.example updated with per-task examples. 6 new bats tests covering union, de-dup, empty-extra, and yaml-driven cases.
     ```

## Test Plan

```
TEST COVERAGE PLAN
===========================
[+] lib/00-common.sh
    |
    +-- is_protected_branch(branch, config_file, extra_branches="")
    |   +-- [NEED TEST] 2-arg form, global match  → case 1
    |   +-- [NEED TEST] 2-arg form, no match      → case 1
    |   +-- [NEED TEST] 3-arg form, task-only hit → case 2
    |   +-- [NEED TEST] 3-arg form, global hit + task list present → case 3a
    |   +-- [NEED TEST] 3-arg form, task-list hit + global unchanged → case 3b
    |   +-- [NEED TEST] 3-arg form, duplicate across lists (no dup-caused error) → case 4
    |   +-- [NEED TEST] 3-arg form, explicit "" third arg == 2-arg behavior → case 5
    |   +-- [NEED TEST] 3-arg form, list fetched from a fixture tasks.yaml via yq → case 6
    |
[+] lib/run.sh (integration — covered by existing bats suite)
    |
    +-- nightcrew_run task loop
        +-- [REGRESSION] existing multi-project / cli / preflight tests still pass
        +-- Existing call at line 855 now 3-arg; task_protected_branches empty when
            field absent → behaves identically to prior 2-arg call
[+] schemas/task.schema.json
    |
    +-- additionalProperties: false
        +-- [COVERED by existing schema.bats regression] a task WITH protected_branches
            must still pass — the field is now a known property

------------------------------
TOTAL: 6 new unit tests + existing suite regression pass
------------------------------
```

### Specific tests in `tests/protected-branches.bats`

File header:
```
#!/usr/bin/env bats
# Tests for is_protected_branch() union logic (lib/00-common.sh)
load test_helper
```

**Case 1 — Global list only, 2-arg form.**
- Setup: write `$TEST_TEMP_DIR/config.yaml` containing `protected_branches: [main, production]`.
- Assert: `is_protected_branch main "$TEST_TEMP_DIR/config.yaml"` returns 0.
- Assert: `is_protected_branch production "$TEST_TEMP_DIR/config.yaml"` returns 0.
- Assert: `is_protected_branch feature/foo "$TEST_TEMP_DIR/config.yaml"` returns non-zero.

**Case 2 — Per-task branch only, 3-arg form.**
- Setup: config with `protected_branches: [main]`.
- Assert: `is_protected_branch release "$config" "release"` returns 0.
- Assert: `is_protected_branch feature/foo "$config" "release"` returns non-zero.

**Case 3 — Union: both lists hit.**
- Setup: config with `protected_branches: [main]`, extra `"release"`.
- Assert 3a: `is_protected_branch main "$config" "release"` returns 0 (global hit).
- Assert 3b: `is_protected_branch release "$config" "release"` returns 0 (task hit).
- Assert 3c: `is_protected_branch other "$config" "release"` returns non-zero.

**Case 4 — De-dup across lists, no shell errors.**
- Setup: config with `protected_branches: [main]`, extra = `$'main\nrelease'` (newline-joined so de-dup path exercised).
- Assert: `is_protected_branch main "$config" "$extra"` returns 0.
- Assert: `is_protected_branch release "$config" "$extra"` returns 0.
- Assert: `run` captures no stderr noise (`"$output"` does not contain `command not found` / `bad substitution`).

**Case 5 — Empty `extra` equivalence.**
- Setup: config with `protected_branches: [main]`.
- Assert: `is_protected_branch main "$config" ""` returns 0 (identical to 2-arg).
- Assert: `is_protected_branch feature/foo "$config" ""` returns non-zero.

**Case 6 — Task-level via tasks.yaml (yq-driven).**
- Setup: fixture `$TEST_TEMP_DIR/tasks.yaml` with one task declaring `protected_branches: [release]`; separate config with `protected_branches: [main]`.
- Fetch with `extra=$(yq e '.tasks[0].protected_branches[]?' "$TEST_TEMP_DIR/tasks.yaml")`.
- Assert: `is_protected_branch release "$config" "$extra"` returns 0.
- Assert: `is_protected_branch main "$config" "$extra"` returns 0.
- Assert: `is_protected_branch other "$config" "$extra"` returns non-zero.

### Regression gate
Run `bats tests/` and confirm zero failures. Existing suites `schema.bats`, `cli-commands.bats`, `multi-project.bats`, `preflight-json.bats`, `validate.bats`, `git-ops.bats` all pass without modification.

## Failure Modes

| Codepath | Failure scenario | Test covers it? | Error handling exists? | What user sees |
|----------|------------------|-----------------|------------------------|----------------|
| `is_protected_branch` with broken/missing config.yaml | yq fails, fallback `main\nmaster\ndevelop` kicks in, union still works | Implicit — fallback branch pre-existed; new code doesn't alter it | Yes — `2>/dev/null \|\| echo -e …` | Behaves as though only default branches are protected; user sees no error (pre-existing behavior preserved). |
| `is_protected_branch` with missing `protected_branches` key in task | `yq '.tasks[$i].protected_branches[]?'` returns empty; union = global only | Case 1 + Case 5 | Yes — `[]?` tolerates missing key, default `""` in function signature | User sees normal run; per-task list simply absent. |
| `is_protected_branch` called with task list containing duplicates or blanks | `awk 'NF' \| sort -u` strips blanks & dedups | Case 4 | Yes — `awk 'NF'` + `sort -u` | No stderr noise; branch is still evaluated correctly. |
| `lib/run.sh:855` when task uses protected branch | Existing code path: `log_error` + `mark_task failed` + `continue` | Covered by existing suite (no new assertion needed) | Yes — 3 lines of explicit handling at 856–860 | User sees `ERROR: Refusing to work on protected branch: <branch>` in logs and `state/progress.json` marks the task failed with reason `"protected branch"`. |
| Schema validation when task declares `protected_branches: [x]` | Without schema update: `additionalProperties: false` rejects the task; with schema update: accepts | Implicit (existing `schema.bats` would fail if field rejected); spec flags this explicitly | Yes — preflight refuses to queue on schema violation with clear error line | If schema update is skipped, user sees preflight error `Task i has unknown property 'protected_branches'` and run aborts. Schema update eliminates this. |
| User sets task-level `protected_branches: []` (empty array) | yq emits nothing; union = global only | Case 5 (empty extra equivalent) | Yes — `awk 'NF'` strips blank | Normal run; empty array = no additions. |
| User sets `protected_branches` with a global branch (e.g. `main`) redundantly | De-dup removes duplicate | Case 4 | Yes — `sort -u` | Normal run; no user-visible effect. |
| Runtime YAML shape mismatch (`protected_branches: "main"` as string, not array) | `yq '.protected_branches[]?'` errors on non-array; returns empty or warning | NOT explicitly tested; low-probability, schema rejects at preflight | Partial — schema catches it at preflight (`"type": "array"`) before loop runs | Preflight error: task fails schema validation; run does not start. |

No critical gaps: every failure mode is either tested, pre-existing-and-covered, or gated by schema validation upstream.

## NOT In Scope
- CLI flag or env var to override `protected_branches` (spec: per-task YAML only).
- `config.yaml`-side `projects` section or alternate config location.
- Weakening global protection via per-task config (design is union, not override).
- Early preflight rejection specifically for per-task protected-branch violations (runtime handling at `lib/run.sh:855` is sufficient and already exists).
- Changes to `lib/git-ops.sh` / `tests/git-ops.bats` — neither references `is_protected_branch`; listing them in Files In Scope is permissive, not required.
- Changes to `lib/validate.sh`, `server.js`, `dashboard.html`, `index.html`, or `templates/` — no user-facing surface for this feature.
- CHANGELOG.md, VERSION bump, `docs/`, `nightcrew-architecture.md` updates — scoped out per task description.
- A new fixture file under `tests/fixtures/` — Case 6 writes its tasks.yaml inline to `$TEST_TEMP_DIR` (mirrors existing bats patterns).
- Edits to `tests/test_helper.bash` — no new source line needed; `lib/00-common.sh` is already sourced at line 24.
- Surfacing per-task protected-branch info in the web UI / dashboard / API.
- Distribution: no new artifact; NightCrew is a bash tool installed from the repo. Nothing to publish.

## Decisions Log

1. **Signature of `is_protected_branch` — append third arg vs. named map.**
   - Alternatives: (a) append optional 3rd positional arg with empty default [CHOSEN]; (b) change signature to named arg style via `--extra`; (c) introduce a global `NIGHTCREW_EXTRA_PROTECTED` env var.
   - Rationale: (a) is minimal-diff, backward-compatible with one existing caller, and matches spec verbatim. (b) would force rewriting the call site and complicate testing. (c) is implicit global state — violates "explicit over clever".

2. **Per-task list passing format — newline vs. space vs. array.**
   - Alternatives: (a) newline-separated string [CHOSEN]; (b) space-separated string; (c) bash array via `declare -a` and `"${arr[@]}"`.
   - Rationale: (a) matches `yq e '.protected_branches[]'` output directly and survives branch names containing `/`. (b) breaks on slashes and forces tokenization. (c) requires bash 4+ (already required) but complicates the call signature and mocking.

3. **Union algorithm — `sort -u` vs. associative array dedup.**
   - Alternatives: (a) `printf | awk 'NF' | sort -u` [CHOSEN]; (b) bash associative array; (c) awk-only dedup.
   - Rationale: (a) is one line, handles empty lists, portable. (b) works but adds 4+ lines of bash for marginal gain. (c) loses stable ordering less cleanly.

4. **Preserve fallback `main\nmaster\ndevelop` behavior.**
   - Alternatives: (a) keep the fallback verbatim [CHOSEN]; (b) remove fallback, require config to list branches; (c) make fallback configurable.
   - Rationale: (a) is a zero-regression guarantee — users who never touched `config.yaml.protected_branches` see identical behavior. (b) would silently broaden attack surface. (c) scope creep.

5. **yq expression for missing key — `[]?` vs. `// []`.**
   - Alternatives: (a) `yq e ".tasks[$i].protected_branches[]?"` [CHOSEN]; (b) `yq e '.tasks[$i].protected_branches // [] | .[]'`.
   - Rationale: (a) is the idiomatic yq-mike way to tolerate missing keys and emits one branch per line. (b) works but is more verbose.

6. **Schema placement — between `project_path` and `retry_strategy` vs. end of properties.**
   - Alternatives: (a) between project_path and retry_strategy [CHOSEN per spec]; (b) alphabetical; (c) end of block.
   - Rationale: (a) keeps multi-project-adjacent fields grouped; spec prescribes this exact placement.

7. **Test fixture strategy — new fixture file vs. inline temp yaml.**
   - Alternatives: (a) inline yaml written to `$TEST_TEMP_DIR` per case [CHOSEN]; (b) add `tests/fixtures/tasks-protected-branches.yaml`.
   - Rationale: (a) matches existing patterns in `schema.bats:100-127`; keeps each test self-contained. (b) adds a file that's used by exactly one case.

8. **README.md edit — surgical vs. new section.**
   - Alternatives: (a) replace the trailing sentence of the existing paragraph + yaml snippet [CHOSEN per spec]; (b) add a new `### Per-Task Protected Branches` subsection.
   - Rationale: (a) is the minimum viable doc change per the spec ("Do not add a whole new section"). (b) overshoots.

9. **tasks.yaml.example — commented field vs. active example task.**
   - Alternatives: (a) commented field under an existing task [CHOSEN per spec]; (b) a third fully-populated example task demonstrating the feature.
   - Rationale: (a) preserves the existing working example intact. (b) adds noise.

10. **Where to parse `task_protected_branches` — at the call site vs. with other task fields.**
    - Alternatives: (a) at the top of each loop iteration alongside other `yq` task-field parses [CHOSEN]; (b) lazily right before the call at line 855.
    - Rationale: (a) matches the codified pattern at lines 786–804 and keeps all YAML parsing co-located. (b) would sprinkle yq calls deeper in the body.

11. **No `validate.sh` changes for type-checking per-task `protected_branches`.**
    - Alternatives: (a) rely on JSON schema's `"type": "array"` + preflight schema validation [CHOSEN]; (b) add a runtime type check in `lib/run.sh`.
    - Rationale: (a) — the existing `preflight_validate` already enforces the schema via `jq`, so a non-array value is rejected before the run loop starts. (b) duplicates what the schema already guarantees.

12. **No CHANGELOG or VERSION bump in this plan.**
    - Alternatives: (a) leave CHANGELOG/VERSION untouched [CHOSEN per scope discipline]; (b) bump patch version and add CHANGELOG entry.
    - Rationale: (a) matches the spec's explicit "Touch only:" list. (b) is for the separate `/ship` workflow.
