#!/usr/bin/env bash
#
# NightCrew — Overnight Claude Code Task Runner
#
# Usage:
#   nightcrew run    [--tasks FILE] [--config FILE] [--dry-run]
#   nightcrew review [--config FILE]
#
set -euo pipefail

NIGHTCREW_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NIGHTCREW_VERSION="0.3.0"

# Source all lib modules
for lib in "$NIGHTCREW_DIR"/lib/*.sh; do
  # shellcheck source=/dev/null
  source "$lib"
done

usage() {
  cat <<'EOF'
NightCrew — Overnight Claude Code Task Runner

Usage:
  nightcrew run       [OPTIONS]    Queue tasks and run overnight
  nightcrew review    [OPTIONS]    Morning review dashboard
  nightcrew serve     [OPTIONS]    Start web UI server
  nightcrew preflight [OPTIONS]    Run preflight checks
  nightcrew config    [OPTIONS]    Show resolved configuration

Options:
  --tasks FILE     Path to tasks.yaml (default: ./tasks.yaml)
  --config FILE    Path to config.yaml (default: ./config.yaml)
  --dry-run        Show what would run without executing (includes preflight validation)
  --open           Open dashboard in browser after review
  --json           Output as JSON (for preflight, config)
  --port PORT      Server port (default: 3721, for serve)
  --version        Show version
  --help           Show this help

Examples:
  # Before bed
  vim tasks.yaml
  ./nightcrew.sh run

  # In the morning
  ./nightcrew.sh review

  # Web UI
  ./nightcrew.sh serve

  # Check readiness
  ./nightcrew.sh preflight --json
EOF
}

# Parse arguments
COMMAND=""
TASKS_FILE="./tasks.yaml"
CONFIG_FILE="./config.yaml"
DRY_RUN=false
OPEN_DASHBOARD=false
JSON_OUTPUT=false
SERVE_PORT=3721

while [[ $# -gt 0 ]]; do
  case "$1" in
    run|review|serve|preflight|config)
      COMMAND="$1"
      shift
      ;;
    --tasks)
      TASKS_FILE="$2"
      shift 2
      ;;
    --config)
      CONFIG_FILE="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --open)
      OPEN_DASHBOARD=true
      shift
      ;;
    --json)
      JSON_OUTPUT=true
      shift
      ;;
    --port)
      SERVE_PORT="$2"
      shift 2
      ;;
    --version)
      echo "nightcrew $NIGHTCREW_VERSION"
      exit 0
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$COMMAND" ]]; then
  usage
  exit 1
fi

case "$COMMAND" in
  run)
    nightcrew_run "$TASKS_FILE" "$CONFIG_FILE" "$DRY_RUN"
    ;;
  review)
    nightcrew_review "$CONFIG_FILE"
    if [[ "$OPEN_DASHBOARD" == "true" && -f "$NIGHTCREW_DIR/state/dashboard.html" ]]; then
      open "$NIGHTCREW_DIR/state/dashboard.html" 2>/dev/null || \
        xdg-open "$NIGHTCREW_DIR/state/dashboard.html" 2>/dev/null || \
        echo "Dashboard: file://$NIGHTCREW_DIR/state/dashboard.html"
    fi
    ;;
  serve)
    if ! command -v node >/dev/null 2>&1; then
      echo "Error: Node.js is required for 'nightcrew serve'. Install it and try again." >&2
      exit 1
    fi
    if [[ ! -f "$NIGHTCREW_DIR/server.js" ]]; then
      echo "Error: server.js not found in $NIGHTCREW_DIR" >&2
      exit 1
    fi
    export NIGHTCREW_DIR TASKS_FILE CONFIG_FILE SERVE_PORT
    exec node "$NIGHTCREW_DIR/server.js"
    ;;
  preflight)
    nightcrew_preflight "$TASKS_FILE" "$CONFIG_FILE" "$JSON_OUTPUT"
    ;;
  config)
    nightcrew_config "$CONFIG_FILE" "$JSON_OUTPUT"
    ;;
esac
