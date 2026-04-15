#!/usr/bin/env bash
# Token benchmark: compare two session snapshots

nightcrew_benchmark() {
  local session_a="$1"
  local session_b="$2"
  local base_dir="${3:-.}"

  local file_a="$base_dir/state/sessions/$session_a/progress.json"
  local file_b="$base_dir/state/sessions/$session_b/progress.json"

  if [[ ! -f "$file_a" ]]; then
    echo "Error: session '$session_a' not found at $file_a"
    return 1
  fi
  if [[ ! -f "$file_b" ]]; then
    echo "Error: session '$session_b' not found at $file_b"
    return 1
  fi

  echo ""
  echo "TOKEN BENCHMARK: $session_a vs $session_b"
  echo "═══════════════════════════════════════════════════════════"
  printf "%-20s | %-8s | %10s | %10s | %10s | %6s\n" "Task" "Phase" "Baseline" "Compressed" "Delta" "Savings"
  echo "─────────────────────────────────────────────────────────────────"

  local total_a=0 total_b=0

  # Get task IDs from session A
  local task_ids
  task_ids=$(jq -r '.tasks | keys[]' "$file_a" 2>/dev/null)

  for task_id in $task_ids; do
    local task_total_a=0 task_total_b=0

    for phase in plan impl review; do
      local in_field="${phase}_in_tokens"
      local out_field="${phase}_out_tokens"

      local a_in a_out b_in b_out
      a_in=$(jq -r ".tasks[\"$task_id\"].$in_field // 0" "$file_a" 2>/dev/null)
      a_out=$(jq -r ".tasks[\"$task_id\"].$out_field // 0" "$file_a" 2>/dev/null)
      b_in=$(jq -r ".tasks[\"$task_id\"].$in_field // 0" "$file_b" 2>/dev/null)
      b_out=$(jq -r ".tasks[\"$task_id\"].$out_field // 0" "$file_b" 2>/dev/null)

      local phase_a=$((a_in + a_out))
      local phase_b=$((b_in + b_out))

      if [[ $phase_a -eq 0 && $phase_b -eq 0 ]]; then
        continue
      fi

      local delta=$((phase_b - phase_a))
      local savings="0%"
      if [[ $phase_a -gt 0 ]]; then
        savings=$(awk "BEGIN{printf \"%.0f%%\", ($delta / $phase_a) * 100}")
      fi

      printf "%-20s | %-8s | %10s | %10s | %10s | %6s\n" \
        "$task_id" "$phase" "$phase_a" "$phase_b" "$delta" "$savings"

      task_total_a=$((task_total_a + phase_a))
      task_total_b=$((task_total_b + phase_b))
    done

    # Task total row
    if [[ $task_total_a -gt 0 || $task_total_b -gt 0 ]]; then
      local task_delta=$((task_total_b - task_total_a))
      local task_savings="0%"
      if [[ $task_total_a -gt 0 ]]; then
        task_savings=$(awk "BEGIN{printf \"%.0f%%\", ($task_delta / $task_total_a) * 100}")
      fi
      printf "%-20s | %-8s | %10s | %10s | %10s | %6s\n" \
        "$task_id" "TOTAL" "$task_total_a" "$task_total_b" "$task_delta" "$task_savings"
      echo "─────────────────────────────────────────────────────────────────"
    fi

    total_a=$((total_a + task_total_a))
    total_b=$((total_b + task_total_b))
  done

  # Session totals
  local session_delta=$((total_b - total_a))
  local session_savings="0%"
  if [[ $total_a -gt 0 ]]; then
    session_savings=$(awk "BEGIN{printf \"%.0f%%\", ($session_delta / $total_a) * 100}")
  fi
  printf "%-20s | %-8s | %10s | %10s | %10s | %6s\n" \
    "SESSION TOTAL" "" "$total_a" "$total_b" "$session_delta" "$session_savings"

  # Estimate cost (rough: Opus $15/$75 per M, Sonnet $3/$15 per M, assume 50/50 split)
  # Use a blended rate of $9/$45 per M tokens (avg of Opus and Sonnet)
  local cost_a cost_b cost_delta
  cost_a=$(awk "BEGIN{printf \"%.2f\", $total_a / 1000000 * 27}")
  cost_b=$(awk "BEGIN{printf \"%.2f\", $total_b / 1000000 * 27}")
  cost_delta=$(awk "BEGIN{printf \"%.2f\", $cost_b - $cost_a}")
  printf "%-20s | %-8s | %10s | %10s | %10s | %6s\n" \
    "ESTIMATED COST" "" "\$$cost_a" "\$$cost_b" "\$$cost_delta" "$session_savings"

  echo "═══════════════════════════════════════════════════════════"

  # Task success comparison
  echo ""
  echo "TASK OUTCOMES:"
  for task_id in $task_ids; do
    local status_a status_b
    status_a=$(jq -r ".tasks[\"$task_id\"].status // \"unknown\"" "$file_a" 2>/dev/null)
    status_b=$(jq -r ".tasks[\"$task_id\"].status // \"unknown\"" "$file_b" 2>/dev/null)
    if [[ "$status_a" != "$status_b" ]]; then
      echo "  $task_id: $status_a → $status_b (CHANGED)"
    else
      echo "  $task_id: $status_a (same)"
    fi
  done
}
