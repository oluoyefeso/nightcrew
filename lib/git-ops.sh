#!/usr/bin/env bash
# Git operations: worktree, branch, commit, push, PR

WORKTREE_BASE=".worktrees"

setup_worktree() {
  local repo_dir="$1"
  local task_id="$2"
  local branch="$3"
  local base_branch="${4:-main}"

  local worktree_path="$repo_dir/$WORKTREE_BASE/$task_id"

  # If worktree already exists (resume), verify it's still a valid git worktree
  if [[ -d "$worktree_path" ]]; then
    # A proper worktree has a .git file (not directory) linking to the main repo
    if [[ -f "$worktree_path/.git" ]]; then
      echo "$worktree_path"
      return
    else
      # Stale directory from a crashed run — remove and recreate
      rm -rf "$worktree_path"
    fi
  fi

  mkdir -p "$repo_dir/$WORKTREE_BASE"

  # Prune stale worktree references from prior crashed runs
  git -C "$repo_dir" worktree prune >/dev/null 2>&1 || true

  # Check if branch already exists
  if git -C "$repo_dir" rev-parse --verify "$branch" >/dev/null 2>&1; then
    # Branch exists, create worktree from it
    if ! git -C "$repo_dir" worktree add "$worktree_path" "$branch" >/dev/null 2>&1; then
      # Only delete branch if it has no unique commits (safe to recreate)
      local ahead_count
      ahead_count=$(git -C "$repo_dir" rev-list --count "$base_branch".."$branch" 2>/dev/null || echo "0")
      if [[ "$ahead_count" -gt 0 ]]; then
        echo "ERROR: git worktree add failed for branch $branch (branch has $ahead_count commits, refusing to delete)" >&2
        return 1
      fi
      git -C "$repo_dir" branch -D "$branch" >/dev/null 2>&1 || true
      if ! git -C "$repo_dir" worktree add -b "$branch" "$worktree_path" "$base_branch" >/dev/null 2>&1; then
        echo "ERROR: git worktree add failed for branch $branch (tried recreate)" >&2
        return 1
      fi
    fi
  else
    # Create new branch from base
    if ! git -C "$repo_dir" worktree add -b "$branch" "$worktree_path" "$base_branch" >/dev/null 2>&1; then
      echo "ERROR: git worktree add -b failed for branch $branch from $base_branch" >&2
      return 1
    fi
  fi

  # Verify directory was actually created
  if [[ ! -d "$worktree_path" ]]; then
    echo "ERROR: worktree directory not created: $worktree_path" >&2
    return 1
  fi

  echo "$worktree_path"
}

cleanup_worktree() {
  local repo_dir="$1"
  local task_id="$2"

  local worktree_path="$repo_dir/$WORKTREE_BASE/$task_id"
  if [[ -d "$worktree_path" ]]; then
    git -C "$repo_dir" worktree remove "$worktree_path" --force 2>/dev/null || true
  fi
  git -C "$repo_dir" worktree prune 2>/dev/null || true
}

commit_changes() {
  local worktree_dir="$1"
  local message="$2"

  if [[ ! -d "$worktree_dir" ]]; then
    echo "WARNING: commit_changes: directory does not exist: $worktree_dir" >&2
    return 0  # non-blocking
  fi

  local add_stderr
  add_stderr=$(git -C "$worktree_dir" add -A 2>&1) || {
    echo "WARNING: git add failed in $worktree_dir: $add_stderr" >&2
    return 0  # non-blocking
  }

  # Only commit if there are changes
  if ! git -C "$worktree_dir" diff --cached --quiet 2>/dev/null; then
    local commit_stderr
    commit_stderr=$(git -C "$worktree_dir" commit -m "$message" 2>&1) || {
      echo "WARNING: git commit failed in $worktree_dir: $commit_stderr" >&2
      return 0  # non-blocking
    }
  fi
}

push_branch() {
  local worktree_dir="$1"
  local branch="$2"

  if [[ ! -d "$worktree_dir" ]]; then
    echo "ERROR: push_branch: directory does not exist: $worktree_dir" >&2
    return 1
  fi

  git -C "$worktree_dir" push -u origin "$branch" 2>/dev/null
}

create_draft_pr() {
  local worktree_dir="$1"
  local title="$2"
  local body="$3"
  local base_branch="${4:-main}"

  if [[ ! -d "$worktree_dir" ]]; then
    echo "ERROR: create_draft_pr: directory does not exist: $worktree_dir" >&2
    return 1
  fi

  # Check if a PR already exists for this branch
  local branch
  branch=$(git -C "$worktree_dir" branch --show-current)
  local existing_pr
  existing_pr=$(cd "$worktree_dir" && gh pr list --head "$branch" --state open --json url -q '.[0].url' 2>/dev/null || true)

  if [[ -n "$existing_pr" ]]; then
    # Update existing PR body
    local pr_number
    pr_number=$(cd "$worktree_dir" && gh pr list --head "$branch" --state open --json number -q '.[0].number' 2>/dev/null)
    (cd "$worktree_dir" && gh pr edit "$pr_number" --body "$body" 2>/dev/null || true)
    echo "$existing_pr"
  else
    # Create new draft PR
    local pr_url
    pr_url=$(cd "$worktree_dir" && gh pr create \
      --title "$title" \
      --body "$body" \
      --draft \
      --base "$base_branch" 2>/dev/null || true)
    echo "$pr_url"
  fi
}
