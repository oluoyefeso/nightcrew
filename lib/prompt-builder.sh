#!/usr/bin/env bash
# Builds system prompts from templates + task fields using envsubst
#
# Supports three template types:
#   system-prompt.md  — implementation prompt (original)
#   plan-prompt.md    — engineering planning prompt (Opus)
#   review-prompt.md  — pre-PR code review prompt (Sonnet)

_detect_resume_context() {
  local task_id="$1"
  local worktree_dir="$2"
  local base_branch="${3:-main}"

  if [[ -n "$worktree_dir" ]] && [[ -d "$worktree_dir/.git" || -f "$worktree_dir/.git" ]]; then
    local commit_count
    commit_count=$(git -C "$worktree_dir" rev-list --count "$base_branch"..HEAD 2>/dev/null || echo "0")
    if [[ "$commit_count" -gt 0 ]]; then
      echo '## IMPORTANT: You are RESUMING a partially-complete task.
Prior work exists on this branch. Before starting:
1. Run `git log --oneline '"$base_branch"'..HEAD` to see what was already done
2. Read DECISIONS-'"$task_id"'.md if it exists for prior context
3. Review the diff: `git diff '"$base_branch"'...HEAD`
4. Do NOT redo committed work. Continue from where the prior session stopped.'
      return
    fi
  fi
  echo ""
}

build_system_prompt() {
  local task_id="$1"
  local task_title="$2"
  local task_prompt="$3"
  local task_goal="${4:-}"
  local task_branch="$5"
  local task_files_in_scope="${6:-}"
  local template_file="$7"
  local worktree_dir="${8:-}"
  local base_branch="${9:-main}"

  local resume_context
  resume_context=$(_detect_resume_context "$task_id" "$worktree_dir" "$base_branch")

  # Export variables for envsubst
  export TASK_ID="$task_id"
  export TASK_TITLE="$task_title"
  export TASK_PROMPT="$task_prompt"
  export TASK_GOAL="${task_goal:-No specific goal defined.}"
  export TASK_BRANCH="$task_branch"
  export TASK_FILES_IN_SCOPE="${task_files_in_scope:-**/*}"
  export RESUME_CONTEXT="$resume_context"
  export BASE_BRANCH="$base_branch"

  # Render template
  local output_file
  output_file=$(mktemp /tmp/nightcrew-prompt-XXXXXXXX.md)
  envsubst < "$template_file" > "$output_file"

  # Clean up env
  unset TASK_ID TASK_TITLE TASK_PROMPT TASK_GOAL TASK_BRANCH TASK_FILES_IN_SCOPE RESUME_CONTEXT BASE_BRANCH

  echo "$output_file"
}

# Build the planning prompt (uses plan-prompt.md template)
build_plan_prompt() {
  local task_id="$1"
  local task_title="$2"
  local task_prompt="$3"
  local task_goal="${4:-}"
  local task_branch="$5"
  local task_files_in_scope="${6:-}"
  local template_dir="$7"
  local worktree_dir="${8:-}"
  local base_branch="${9:-main}"

  build_system_prompt \
    "$task_id" "$task_title" "$task_prompt" "$task_goal" \
    "$task_branch" "$task_files_in_scope" \
    "$template_dir/plan-prompt.md" "$worktree_dir" "$base_branch"
}

# Build the review prompt (uses review-prompt.md template)
build_review_prompt() {
  local task_id="$1"
  local task_title="$2"
  local task_prompt="$3"
  local task_goal="${4:-}"
  local task_branch="$5"
  local task_files_in_scope="${6:-}"
  local template_dir="$7"
  local worktree_dir="${8:-}"
  local base_branch="${9:-main}"

  build_system_prompt \
    "$task_id" "$task_title" "$task_prompt" "$task_goal" \
    "$task_branch" "$task_files_in_scope" \
    "$template_dir/review-prompt.md" "$worktree_dir" "$base_branch"
}

# Build the implementation prompt with plan context injected
build_impl_prompt() {
  local task_id="$1"
  local task_title="$2"
  local task_prompt="$3"
  local task_goal="${4:-}"
  local task_branch="$5"
  local task_files_in_scope="${6:-}"
  local template_dir="$7"
  local worktree_dir="${8:-}"
  local base_branch="${9:-main}"
  local plan_file="${10:-}"

  # Build the base implementation prompt
  local prompt_file
  prompt_file=$(build_system_prompt \
    "$task_id" "$task_title" "$task_prompt" "$task_goal" \
    "$task_branch" "$task_files_in_scope" \
    "$template_dir/system-prompt.md" "$worktree_dir" "$base_branch")

  # If a plan file exists, inject it into the prompt
  if [[ -n "$plan_file" && -f "$plan_file" ]]; then
    local plan_content
    plan_content=$(cat "$plan_file")
    cat >> "$prompt_file" <<PLAN_EOF

## Implementation Plan (FOLLOW THIS)
An engineering review has already been completed for this task. The plan below
contains architecture decisions, implementation steps, test requirements, and
failure modes. Follow it precisely. Do not deviate unless you find a concrete
reason (e.g., the code has changed since the plan was written).

If you deviate from the plan, document why in DECISIONS-${task_id}.md.

<plan>
$plan_content
</plan>
PLAN_EOF
  fi

  echo "$prompt_file"
}
