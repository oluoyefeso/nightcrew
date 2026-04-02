#!/usr/bin/env bash
# Cost tracking — flat-rate estimate per invocation
#
# With the 3-phase pipeline (plan + implement + review), each task
# incurs ~3 invocations. Typical cost per task:
#   Plan (Opus):      ~$2.50
#   Implement (Sonnet): ~$0.50
#   Review (Sonnet):    ~$0.50
#   Total:            ~$3.50 per task
#
# These are order-of-magnitude estimates, not precise accounting.

estimate_cost_cents() {
  local model="$1"
  local input_tokens="${2:-0}"
  local output_tokens="${3:-0}"

  # If real token data is available, calculate actual cost
  if [[ "$input_tokens" -gt 0 || "$output_tokens" -gt 0 ]] 2>/dev/null; then
    local cost=0
    case "$model" in
      *opus*)
        # Opus: $15/M input, $75/M output
        cost=$(awk "BEGIN {printf \"%d\", ($input_tokens * 15 + $output_tokens * 75) / 10000}")
        ;;
      *sonnet*)
        # Sonnet: $3/M input, $15/M output
        cost=$(awk "BEGIN {printf \"%d\", ($input_tokens * 3 + $output_tokens * 15) / 10000}")
        ;;
      *)
        cost=$(awk "BEGIN {printf \"%d\", ($input_tokens * 3 + $output_tokens * 15) / 10000}")
        ;;
    esac
    # Minimum 1 cent if any tokens were used
    [[ "$cost" -lt 1 ]] && cost=1
    echo "$cost"
    return
  fi

  # Flat-rate fallback (order-of-magnitude estimate)
  case "$model" in
    *opus*)   echo 250 ;;  # ~$2.50 per invocation
    *sonnet*) echo 50 ;;   # ~$0.50 per invocation
    *)        echo 50 ;;
  esac
}

# Parse token usage from JSON output of claude -p --output-format json
parse_token_usage() {
  local json_file="$1"
  if [[ ! -f "$json_file" ]]; then
    echo "0 0"
    return
  fi
  local input_tokens output_tokens
  input_tokens=$(jq -r '.usage.input_tokens // .input_tokens // 0' "$json_file" 2>/dev/null || echo "0")
  output_tokens=$(jq -r '.usage.output_tokens // .output_tokens // 0' "$json_file" 2>/dev/null || echo "0")
  echo "$input_tokens $output_tokens"
}

check_cost_cap() {
  local config_file="$1"
  local max_cost
  max_cost=$(config_get "max_cost_cents" "500" "$config_file")
  local current_cost
  current_cost=$(get_total_cost)

  if [[ "$current_cost" -ge "$max_cost" ]]; then
    log "Cost cap reached: ${current_cost} cents >= ${max_cost} cents cap"
    return 1
  fi
  return 0
}
