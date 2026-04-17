# Pre-Landing Review: feat/broaden-tool-whitelist

Reviewed against `origin/main` on 2026-04-17.

---

## Scope Check

```
Scope Check: DRIFT DETECTED
Intent: Broaden tool whitelist in lib/tool-router.sh for impl/refactor/test; add tests/tool-routing.bats; update TODOS.md
Delivered: Same as intent, plus two extra planning artifacts committed to the repo

Scope creep:
  DECISIONS-broaden-tool-whitelist.md — planning/decision doc, not in stated scope
  PLAN-broaden-tool-whitelist.md      — implementation plan doc, not in stated scope
```

These are benign planning artifacts written by the implementation agent. They don't affect production behavior. However, they pollute the repo root with files that have no ongoing utility post-merge. Consider deleting them before merging or adding `*-broaden-tool-whitelist.md` to `.gitignore`.

---

## Plan Completion

```
PLAN COMPLETION: 4/4 items done, 0 partial, 0 not done

1. lib/tool-router.sh — header diagram updated, test and implementation|refactor arms expanded. DONE.
2. tests/tool-routing.bats — 6 new bats test cases created. DONE.
3. tests/test_helper.bash — correctly left unchanged (already sources lib/tool-router.sh). DONE.
4. TODOS.md — active entry removed; completed entry prepended to ## Completed section. DONE.
```

---

## Findings

### [INFORMATIONAL] (confidence: 6/10) lib/tool-router.sh:9 — ASCII table alignment

The `implementation` row's right cell is missing a trailing space before the closing `│`:

```
# │ test         │ Read/write + git (incl. mv/rm) + test runners + shell helpers │   ← correct
# │ implementation│ Read/write + git (incl. mv/rm) + test runners + shell helpers│   ← missing space
```

Root cause is pre-existing: "implementation" (14 chars) fills the left column completely, leaving no trailing space before the inner `│`. The total row width is correct (the 1-char overflow in the left cell trades against the 1-char deficit in the right cell), so the outer borders align. Purely cosmetic.

**Recommended fix:** Widen the left column by 1 in all rows and the border lines:
change `──────────────` (14 dashes) to `───────────────` (15 dashes) throughout, and add 1 trailing space to every left-column cell. That restores proper padding without misaligning the outer borders.

**Why not auto-fixed:** Requires changing every row and both border lines — touches 9 lines in a comment block with Unicode characters. Beyond the "mechanical and unambiguous" threshold; a human should decide whether to fix it or accept the pre-existing quirk.

---

## No Critical Issues Found

- Whitelist strings: `test` and `implementation|refactor` arms emit byte-identical strings ✓
- `research` arm: unchanged ✓
- Custom-override block (lines 17–21): unchanged ✓
- Generic fallback `*` arm: unchanged ✓
- Dropped `Bash(npx tsc*)` from impl/refactor: safe — `Bash(npx*)` subsumes it ✓
- No shell injection vectors ✓
- Existing `routing.bats` tests (lines 79–130): no regressions — new whitelist is a strict superset of every substring those tests assert ✓

---

## Auto-Fixed Items

None.

---

## Summary

```
PRE-LANDING REVIEW: 1 issue (0 critical, 1 informational)
Auto-fixed: 0 items
Needs human review: 1 item (see above — ASCII alignment, pre-existing cosmetic)
Scope: DRIFT DETECTED (2 planning markdown files committed outside stated scope)
Plan completion: 4/4
```
