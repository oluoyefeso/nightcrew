#!/usr/bin/env bash
# Model routing based on task type, complexity, and phase
#
# Three-phase pipeline: PLAN -> IMPLEMENT -> REVIEW
#
# ┌───────────┬──────────────┬─────────────┬────────────────────────┐
# │ Phase     │ Task Type    │ Complexity  │ Model                  │
# ├───────────┼──────────────┼─────────────┼────────────────────────┤
# │ plan      │ any          │ any         │ Opus  (reasoning)      │
# ├───────────┼──────────────┼─────────────┼────────────────────────┤
# │ implement │ research     │ any         │ Sonnet                 │
# │ implement │ test         │ low/medium  │ Sonnet                 │
# │ implement │ test         │ high        │ Opus                   │
# │ implement │ implementation│ any        │ Sonnet (follows plan)  │
# │ implement │ refactor     │ low/medium  │ Sonnet                 │
# │ implement │ refactor     │ high        │ Opus                   │
# ├───────────┼──────────────┼─────────────┼────────────────────────┤
# │ review    │ any          │ any         │ Sonnet (diff analysis) │
# └───────────┴──────────────┴─────────────┴────────────────────────┘
#
# Key insight: Opus drafts the plan (architectural reasoning), Sonnet
# implements it (following clear instructions). Implementation tasks
# always use Sonnet because the plan eliminates ambiguity.

route_model() {
  local task_type="$1"
  local complexity="${2:-medium}"
  local config_file="${3:-./config.yaml}"
  local phase="${4:-implement}"

  local default_model
  local complex_model
  default_model=$(config_get "models.default" "claude-sonnet-4-20250514" "$config_file")
  complex_model=$(config_get "models.complex" "claude-opus-4-20250514" "$config_file")

  case "$phase" in
    plan)
      # Planning always uses Opus — architectural reasoning is the bottleneck
      echo "$complex_model"
      ;;
    review)
      # Review always uses Sonnet — diff analysis is pattern matching
      echo "$default_model"
      ;;
    implement)
      case "$task_type" in
        research)
          echo "$default_model"
          ;;
        implementation)
          # Implementation always uses Sonnet when a plan exists.
          # The plan eliminates the need for Opus-level reasoning.
          echo "$default_model"
          ;;
        test|refactor)
          if [[ "$complexity" == "high" ]]; then
            echo "$complex_model"
          else
            echo "$default_model"
          fi
          ;;
        *)
          echo "$default_model"
          ;;
      esac
      ;;
    *)
      echo "$default_model"
      ;;
  esac
}
