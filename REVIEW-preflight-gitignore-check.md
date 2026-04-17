# Pre-Landing Review: feat/preflight-gitignore-check

## [NEEDS REVIEW] [informational] (confidence: 6/10) lib/preflight-gitignore.sh:117 — O(n) git subprocesses in expansion path

The expansion path (glob with wildcard, fast path miss) runs one `git check-ignore -v` subprocess per file found under the prefix directory:

```bash
while IFS= read -r full_path; do
  ...
  if exp_ci=$(git -C "$project_path" check-ignore -v "$rel_path" 2>/dev/null); then
```

For a prefix directory with many files (e.g. `src/**` on a large codebase), this spawns one git process per file. A repo with 1 000 files under `src/` would spawn 1 000 git processes at preflight time.

**Recommended fix:** Replace the per-file loop with a single `git check-ignore -v --stdin` call, piping all relative paths at once:

```bash
local violations_found
violations_found=$(
  find "$prefix_dir" -type f 2>/dev/null \
    | sed "s|^$project_path/||" \
    | git -C "$project_path" check-ignore -v --stdin 2>/dev/null
)
while IFS= read -r exp_ci; do
  [[ -z "$exp_ci" ]] && continue
  _gi_parse_ref "$exp_ci"
  local rel_path
  rel_path=$(printf '%s' "$exp_ci" | cut -f2)
  violation_msgs+=("  [GITIGNORED] task $task_id: files_in_scope pattern \"$glob\" matches gitignored path $rel_path ($_GI_FILE:$_GI_LINE \"$_GI_PATTERN\")")
  violations=$((violations + 1))
done <<< "$violations_found"
```

**Why not auto-fixed:** The fix changes the parsing logic and output format of `_gi_parse_ref` (which currently expects a single line, not the two-column `--stdin` output). It is >20 lines to do safely and needs tests updated to cover the new code path.

**Impact:** Low for typical repos (files_in_scope globs usually have a narrow prefix). Only becomes noticeable on large codebases with broad globs like `src/**`.
