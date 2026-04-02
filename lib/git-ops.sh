#!/usr/bin/env bash
# Git operations: worktree, branch, commit, push, PR

WORKTREE_BASE=".worktrees"

setup_worktree() {
  local repo_dir="$1"
  local task_id="$2"
  local branch="$3"
  local base_branch="${4:-main}"

  local worktree_path="$repo_dir/$WORKTREE_BASE/$task_id"

  # If worktree already exists (resume), just return the path
  if [[ -d "$worktree_path" ]]; then
    echo "$worktree_path"
    return
  fi

  mkdir -p "$repo_dir/$WORKTREE_BASE"

  # Check if branch already exists
  if git -C "$repo_dir" rev-parse --verify "$branch" >/dev/null 2>&1; then
    # Branch exists, create worktree from it
    git -C "$repo_dir" worktree add "$worktree_path" "$branch" 2>/dev/null
  else
    # Create new branch from base
    git -C "$repo_dir" worktree add -b "$branch" "$worktree_path" "$base_branch" 2>/dev/null
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

  git -C "$worktree_dir" add -A 2>/dev/null || true
  # Only commit if there are changes
  if ! git -C "$worktree_dir" diff --cached --quiet 2>/dev/null; then
    git -C "$worktree_dir" commit -m "$message" 2>/dev/null || true
  fi
}

push_branch() {
  local worktree_dir="$1"
  local branch="$2"

  git -C "$worktree_dir" push -u origin "$branch" 2>/dev/null
}

create_draft_pr() {
  local worktree_dir="$1"
  local title="$2"
  local body="$3"
  local base_branch="${4:-main}"

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
