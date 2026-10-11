#!/usr/bin/env bash
# Preflight validator: refuse tasks whose files_in_scope globs reference gitignored paths.
#
# Exported function:
#   check_files_in_scope_gitignored <tasks_file> <config_file>
#     Returns 0 if all files_in_scope globs are tracked (not gitignored).
#     Returns 1 if any glob matches a gitignored path.
#     Violations are written to stderr in the format:
#       [GITIGNORED] task <id>: files_in_scope pattern "<glob>" matches
#         gitignored path <path> (<gitignore_file>:<line> "<pattern>")
#     On success, prints a one-line summary to stdout.
#
# Algorithm:
#   1. For each task with files_in_scope, resolve project_path (fall back to repo_path).
#   2. For each glob:
#      a. Skip pure wildcard patterns (starting with *) — no literal prefix to resolve.
#      b. Run git check-ignore -v on the literal glob string (fast path for exact paths
#         and patterns like state/** whose parent dir is ignored).
#      c. If the glob contains wildcards, extract the literal prefix, find all files
#         under that prefix directory, and run git check-ignore -v on each.
#   3. Report all violations to stderr; return 1 if any found, 0 if clean.

# _gi_parse_ref <check_ignore_line>
# Parses the source:line:pattern field from git check-ignore -v output.
# Sets _GI_FILE, _GI_LINE, _GI_PATTERN in the caller's scope.
_gi_parse_ref() {
  local ci_field
  ci_field=$(printf '%s' "$1" | head -1 | cut -f1)
  _GI_FILE=$(printf '%s' "$ci_field" | cut -d: -f1)
  _GI_LINE=$(printf '%s' "$ci_field" | cut -d: -f2)
  _GI_PATTERN=$(printf '%s' "$ci_field" | cut -d: -f3-)
}

check_files_in_scope_gitignored() {
  local tasks_file="$1"
  local config_file="$2"

  local violations=0
  local -a violation_msgs=()

  if [[ ! -f "$tasks_file" ]]; then
    echo "files_in_scope: no gitignored targets found"
    return 0
  fi

  local task_count
  task_count=$(yq e '.tasks | length' "$tasks_file" 2>/dev/null || echo 0)
  if [[ "$task_count" -eq 0 ]]; then
    echo "files_in_scope: no gitignored targets found"
    return 0
  fi

  local default_project_path
  default_project_path=$(config_get "repo_path" "$(pwd)" "$config_file")

  local i
  for i in $(seq 0 $((task_count - 1))); do
    local task_id
    task_id=$(yq e ".tasks[$i].id" "$tasks_file")

    local files_count
    files_count=$(yq e ".tasks[$i].files_in_scope // [] | length" "$tasks_file" 2>/dev/null || echo 0)
    [[ "$files_count" -eq 0 ]] && continue

    local project_path
    project_path=$(yq e ".tasks[$i].project_path // \"\"" "$tasks_file")
    if [[ -z "$project_path" || "$project_path" == "null" ]]; then
      project_path="$default_project_path"
    fi

    # Skip tasks whose project is not a git repository
    [[ ! -d "$project_path/.git" ]] && continue

    local j
    for j in $(seq 0 $((files_count - 1))); do
      local glob
      glob=$(yq e ".tasks[$i].files_in_scope[$j]" "$tasks_file")
      [[ -z "$glob" || "$glob" == "null" ]] && continue

      # Skip pure wildcard patterns (e.g. **/*.ts, *.sh) — no literal prefix to check
      if [[ "$glob" == \** ]]; then
        continue
      fi

      # ── Fast path: check the literal glob string against gitignore ─────────
      # Catches exact paths (design/foo/FILE.md) and patterns whose parent dir is
      # ignored (state/** when state/ is gitignored).
      local lit_ci
      if lit_ci=$(git -C "$project_path" check-ignore -v "$glob" 2>/dev/null); then
        _gi_parse_ref "$lit_ci"
        violation_msgs+=("  [GITIGNORED] task $task_id: files_in_scope pattern \"$glob\" matches gitignored path $glob ($_GI_FILE:$_GI_LINE \"$_GI_PATTERN\")")
        violations=$((violations + 1))
        continue   # literal match is conclusive; skip expansion
      fi

      # ── Expansion path: find files under the literal prefix, check each ────
      if [[ "$glob" == *"*"* ]]; then
        # Extract the part before the first wildcard
        local prefix="${glob%%\**}"
        prefix="${prefix%/}"   # strip trailing slash

        [[ -z "$prefix" ]] && continue   # pure wildcard prefix — nothing to expand

        local prefix_dir="$project_path/$prefix"
        [[ ! -e "$prefix_dir" ]] && continue

        local full_path
        while IFS= read -r full_path; do
          [[ -z "$full_path" ]] && continue
          local rel_path="${full_path#"$project_path"/}"
          local exp_ci
          if exp_ci=$(git -C "$project_path" check-ignore -v "$rel_path" 2>/dev/null); then
            _gi_parse_ref "$exp_ci"
            violation_msgs+=("  [GITIGNORED] task $task_id: files_in_scope pattern \"$glob\" matches gitignored path $rel_path ($_GI_FILE:$_GI_LINE \"$_GI_PATTERN\")")
            violations=$((violations + 1))
          fi
        done < <(find "$prefix_dir" -type f 2>/dev/null || true)
      fi
    done
  done

  if [[ ${#violation_msgs[@]} -gt 0 ]]; then
    local msg
    for msg in "${violation_msgs[@]}"; do
      echo "$msg" >&2
    done
  fi

  if [[ $violations -gt 0 ]]; then
    return 1
  fi
  echo "files_in_scope: no gitignored targets found"
  return 0
}
