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

Apps only expose their accessibility tree when AT-SPI is switched on (`org.a11y.Status IsEnabled`; the gsettings key alone doesn't guarantee it). `inspect` switches it on when it's off and says so in `errors`. Browsers decide when they start:

- **Zen and other Firefox-based browsers** register as soon as it is on, even if already running. The page URL comes from the document's `DocURL` attribute.
- **Helium and other Chromium-based browsers** check only at launch: restart them once after switching it on (or launch with `--force-renderer-accessibility`). The page URL comes from the document's `URI` attribute.

Apps without a tree (foot, most games, images) get OCR instead.

## Tools

| Tier | MCP tools | CLI |
|---|---|---|
| Observe | `desktop_state`, `screenshot`, `notifications`, `inspect` | `puck state`, `puck inspect …`, `puck pointer` |
| Arrange | `focus_window`, `move_window`, `arrange_windows`, `switch_workspace`, `launch_app`, `layout_snapshot`, `layout_restore`, `dismiss_notification`, `shell_settings` | `puck snapshot`, `puck restore` |
| Invasive (`PUCK_INVASIVE=1`) | `close_window`, `kill_window`, `type_text`, `press_keys`, `pointer_move`, `click`, `drag`, `scroll` | `puck pointer move\|click\|drag\|scroll`, `puck keys` |

```sh
puck inspect (--region X,Y,WxH | --window ID | --point X,Y | --pointer) \
             [--text auto|accessibility|ocr|none] [--screenshot PATH] --json
puck pointer                               # what is under the pointer
puck pointer move X,Y
puck pointer click [X,Y] [--button left|right|middle] [--count N] [--overlay NS]
puck pointer drag X,Y X,Y [--button …] [--overlay NS]
puck pointer scroll [X,Y] [--dx N] [--dy N] [--overlay NS]   # wheel steps; --dy=-3 scrolls up
puck keys (--window ID | --overlay NS) CHORD…              # e.g. ctrl+l Return, Escape
```

Coordinates are global logical pixels, as `puck state` reports them; write negative values as `--point=-10,20`, and put `--` before negative positionals. Click, drag and scroll put the pointer and focus back afterwards.

Input is refused while a shell surface (launcher, panel, picker) has the keyboard, since it would take input meant for a window. To drive a picker on purpose, name its layer-shell namespace: `--overlay selection` for slurp, or `overlay: "selection"` on the MCP `click`, `drag`, `scroll` and `press_keys` tools (`press_keys` then takes no `window_id`). Input goes ahead only while that overlay has the keyboard and lies under every point. `PUCK_OUTPUTS` still applies.

```sh
printf '3292,46 1418x843 editor\n' | slurp &   # a picker over window boxes
puck pointer click 3500,300 --overlay selection   # slurp prints 3292,46 1418x843
puck keys --overlay selection Escape              # or cancel it
```

### Which windows are on screen

`puck state` and `desktop_state` give every window its `output`, `workspace_active` (its workspace is the one shown on that output) and `on_screen`: the part of its rectangle on that output, or `null` when it's hidden, minimized or in a scrolled-away column. Trust `on_screen` to decide what the user can see or click. `x`/`y`/`width`/`height` are the window's full layout rectangle, which for scrolled columns lies off its output, and Umbriel's `visible` stays true for them.

### OCR

Text from apps without an accessibility tree is read by `tesseract` from a capture at the output's own pixels. Puck first makes text dark on light, paints out ruling lines (table grids, TUI frames) and the slash in slashed zeros, and afterwards reads `O` beside digits as `0`. Terminal windows and anything with a ruled grid are read row by row; other targets keep tesseract's layout analysis, so page columns stay apart. A region cutting through a line of text returns junk for that line.

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
