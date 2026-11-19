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

`inspect` and the pointer commands also need `python3` with `python-gobject` and `at-spi2-core` (accessibility), and `tesseract` with `eng` (OCR).

### Accessibility text and page URLs

Apps only expose their accessibility tree when AT-SPI is switched on, and browsers decide when they start:

```sh
busctl --user set-property org.a11y.Bus /org/a11y/bus org.a11y.Status IsEnabled b true
```

- **Zen and other Firefox-based browsers** register as soon as it is on, even if already running. The page URL comes from the document's `DocURL` attribute.
- **Helium and other Chromium-based browsers** check only at launch: restart them once after switching it on (or launch with `--force-renderer-accessibility`). The page URL comes from the document's `URI` attribute. Boxes inside pages can be off by about 10 px.

Apps without a tree (foot, most games, images) get OCR instead.

## Tools

| Tier | MCP tools | CLI |
|---|---|---|
| Observe | `desktop_state`, `screenshot`, `notifications`, `inspect` | `puck state`, `puck inspect …`, `puck pointer` |
| Arrange | `focus_window`, `move_window`, `arrange_windows`, `switch_workspace`, `launch_app`, `layout_snapshot`, `layout_restore`, `dismiss_notification`, `shell_settings` | `puck snapshot`, `puck restore` |
| Invasive (`PUCK_INVASIVE=1`) | `close_window`, `kill_window`, `type_text`, `press_keys`, `pointer_move`, `click`, `drag`, `scroll` | `puck pointer move\|click\|drag\|scroll` |

```sh
puck inspect (--region X,Y,WxH | --window ID | --point X,Y | --pointer) \
             [--text auto|accessibility|ocr|none] [--screenshot PATH] --json
puck pointer                               # what is under the pointer
puck pointer move X,Y
puck pointer click [X,Y] [--button left|right|middle] [--count N]
puck pointer drag X,Y X,Y [--button …]
puck pointer scroll [X,Y] [--dx N] [--dy N]   # wheel steps; --dy=-3 scrolls up
```

Coordinates are global logical pixels, as `puck state` reports them. Click, drag and scroll put the pointer and focus back afterwards.

## Environment

| Variable | Effect |
|---|---|
| `PUCK_INVASIVE=1` | Adds the invasive MCP tools above |
| `PUCK_OUTPUTS=A,B` | Mutating tools and pointer input only touch these outputs; global changes are off |

## Development

```sh
pnpm test                 # unit tests
pnpm typecheck
scripts/agentic-test.sh "On PUCK-SBX, open Zed and Helium side by side"   # real agent, sandboxed
```
