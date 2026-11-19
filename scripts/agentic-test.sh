#!/usr/bin/env bash
# Runs one desktop task as a real headless Claude session that has only Puck's
# tools, limited to a virtual output so it can't touch the real monitors.
#   scripts/agentic-test.sh "task prompt" [model]
# Creates the PUCK-SBX virtual output if it's missing; destroy it afterwards with
#   umbriel output-destroy PUCK-SBX   (close its windows first)
set -euo pipefail
task=$1 model=${2:-sonnet}
export WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-wayland-0}

if ! umbriel outputs --json | jq -e '.[] | select(.name == "PUCK-SBX")' >/dev/null; then
  umbriel output-create PUCK-SBX 1280x720@60 >/dev/null
fi

config=$(mktemp --suffix=.json)
trap 'rm -f "$config"' EXIT
jq -n --arg cmd "$(command -v puck)" '{mcpServers: {puck: {command: $cmd, args: ["mcp"], env: {PUCK_OUTPUTS: "PUCK-SBX", PUCK_INVASIVE: "1"}}}}' >"$config"

claude -p "$task" --model "$model" --mcp-config "$config" --strict-mcp-config \
  --tools "" --allowedTools "mcp__puck__*" --output-format json |
  jq -r '"turns: \(.num_turns)  cost: $\(.total_cost_usd | . * 100 | round / 100)\n\n\(.result)"'
