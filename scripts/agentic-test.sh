#!/usr/bin/env bash
# Runs one desktop task as a real headless Claude session that has only Puck's
# tools, limited to a virtual output so it can't touch the real monitors.
#   scripts/agentic-test.sh "task prompt" [model]
# Creates the PUCK-SBX virtual output for the run, then closes every window on
# it and destroys it (an invisible output next to the monitors swallows the
# cursor). KEEP_SANDBOX=1 leaves it up for inspection.
set -euo pipefail
task=$1 model=${2:-sonnet}
export WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-wayland-0}
sbx=PUCK-SBX

if ! umbriel outputs --json | jq -e --arg o "$sbx" '.[] | select(.name == $o)' >/dev/null; then
  umbriel output-create "$sbx" 1280x720@60 >/dev/null
fi

config=$(mktemp --suffix=.json)
cleanup() {
  rm -f "$config"
  [[ ${KEEP_SANDBOX:-} == 1 ]] && return
  # Only test windows live on the sandbox; destroying it with windows on it would move them to a real monitor.
  for id in $(umbriel windows --json | jq -r --arg o "$sbx" '.[] | select(.output == $o) | .id'); do
    umbriel msg window-close "$id" || true
  done
  sleep 1
  umbriel windows --json | jq -e --arg o "$sbx" 'any(.output == $o)' >/dev/null &&
    echo "windows still open on $sbx; left it up" >&2 && return
  umbriel output-destroy "$sbx"
}
trap cleanup EXIT
jq -n --arg cmd "$(command -v puck)" --arg o "$sbx" '{mcpServers: {puck: {command: $cmd, args: ["mcp"], env: {PUCK_OUTPUTS: $o, PUCK_INVASIVE: "1"}}}}' >"$config"

claude -p "$task" --model "$model" --mcp-config "$config" --strict-mcp-config \
  --tools "" --allowedTools "mcp__puck__*" --output-format json |
  jq -r '"turns: \(.num_turns)  cost: $\(.total_cost_usd | . * 100 | round / 100)\n\n\(.result)"'
