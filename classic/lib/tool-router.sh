#!/usr/bin/env bash
# Tool routing — allowedTools whitelist per task type
#
# ┌──────────────┬───────────────────────────────────────────────────────────────┐
# │ Task Type    │ allowedTools                                                  │
# ├──────────────┼───────────────────────────────────────────────────────────────┤
# │ research     │ Read-only + curl                                              │
# │ test         │ Read/write + git (incl. mv/rm) + test runners + shell helpers │
# │ implementation│ Read/write + git (incl. mv/rm) + test runners + shell helpers│
# │ refactor     │ Same as implementation                                        │
# └──────────────┴───────────────────────────────────────────────────────────────┘

route_tools() {
  local task_type="$1"
  local custom_tools="${2:-}"

  # User override takes precedence
  if [[ -n "$custom_tools" ]]; then
    echo "$custom_tools"
    return
  fi

  case "$task_type" in
    research)
      echo "Read,Grep,Glob,Bash(curl -s*)"
      ;;
    test)
      echo "Read,Grep,Glob,Write,Edit,Bash(git add*),Bash(git commit*),Bash(git diff*),Bash(git status*),Bash(git log*),Bash(git mv*),Bash(git rm*),Bash(npm test*),Bash(npx*),Bash(bun test*),Bash(pytest*),Bash(go test*),Bash(bats*),Bash(mkdir*),Bash(test*),Bash(grep*),Bash(ls*),Bash(cat*),Bash(find*),Bash(wc*)"
      ;;
    implementation|refactor)
      echo "Read,Grep,Glob,Write,Edit,Bash(git add*),Bash(git commit*),Bash(git diff*),Bash(git status*),Bash(git log*),Bash(git mv*),Bash(git rm*),Bash(npm test*),Bash(npx*),Bash(bun test*),Bash(pytest*),Bash(go test*),Bash(bats*),Bash(mkdir*),Bash(test*),Bash(grep*),Bash(ls*),Bash(cat*),Bash(find*),Bash(wc*)"
      ;;
    *)
      echo "Read,Grep,Glob,Write,Edit,Bash(git add*),Bash(git commit*),Bash(git diff*),Bash(git status*),Bash(git log*)"
      ;;
  esac
}
