#!/usr/bin/env bash
# Tool routing — allowedTools whitelist per task type
#
# ┌──────────────┬──────────────────────────────────────────┐
# │ Task Type    │ allowedTools                             │
# ├──────────────┼──────────────────────────────────────────┤
# │ research     │ Read-only + curl                         │
# │ test         │ Read/write + git + test runners          │
# │ implementation│ Read/write + git (safe) + test runners  │
# │ refactor     │ Same as implementation                   │
# └──────────────┴──────────────────────────────────────────┘

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
      echo "Read,Grep,Glob,Write,Edit,Bash(git add*),Bash(git commit*),Bash(git diff*),Bash(git status*),Bash(git log*),Bash(npm test*),Bash(npx*),Bash(bun test*),Bash(pytest*),Bash(go test*)"
      ;;
    implementation|refactor)
      echo "Read,Grep,Glob,Write,Edit,Bash(git add*),Bash(git commit*),Bash(git diff*),Bash(git status*),Bash(git log*),Bash(npm test*),Bash(npx tsc*),Bash(npx*),Bash(bun test*),Bash(pytest*),Bash(go test*),Bash(mkdir*)"
      ;;
    *)
      echo "Read,Grep,Glob,Write,Edit,Bash(git add*),Bash(git commit*),Bash(git diff*),Bash(git status*),Bash(git log*)"
      ;;
  esac
}
