<img src="assets/icon.svg" width="64" height="64" alt="">

# Puck

Lets agents see and drive the real desktop on gaia-arch (Umbriel + Noctalia), and shows live T3 agent status in the Noctalia bar. See [DESIGN.md](DESIGN.md).

## Setup

```sh
pnpm install && pnpm build
ln -sf "$PWD/dist/cli.js" ~/.local/bin/puck

# Read-only T3 token for the bar widget and `puck spend`
mkdir -p ~/.config/puck && umask 077
t3 auth session issue --scope orchestration:read --scope diagnostics:read \
  --ttl 365d --label puck --token-only > ~/.config/puck/t3-token

# Bar widget
noctalia msg plugins source add puck path "$PWD/plugin"
noctalia msg plugins enable axl47/puck
# then add "axl47/puck:status" to a bar section, e.g. bar.default.end
```

The MCP server is registered through indexio's `mcp/servers.json` as `puck mcp`.

## Environment

| Variable | Effect |
|---|---|
| `PUCK_INVASIVE=1` | Adds `close_window`, `kill_window`, `type_text`, `press_keys` |
| `PUCK_OUTPUTS=A,B` | Mutating tools only touch these outputs; global changes are off |

## Development

```sh
pnpm test                 # unit tests
pnpm typecheck
scripts/agentic-test.sh "On PUCK-SBX, open Zed and Helium side by side"   # real agent, sandboxed
```
