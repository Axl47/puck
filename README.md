<img src="assets/icon.svg" width="64" height="64" alt="">

# Puck

Lets agents see and drive a desktop on gaia-arch: the real one (Umbriel + Noctalia), or the agent's own private headless one, from [Ward](https://github.com/Axl47/ward). Also shows live T3 agent status in the Noctalia bar. See [DESIGN.md](DESIGN.md).

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

## Which desktop

An agent has a private desktop from [Ward](https://github.com/Axl47/ward), which you don't see: its ward's, or in a T3 thread without a ward, one of the thread's own.

```sh
puck open ./build/my-app                    # or any command that opens a window
puck open helium http://localhost:5173      # a page of a dev server the agent already runs
```

`puck open CMD` is the one way to open something for a check. It starts the private desktop if needed, runs `CMD` on it detached, waits for the window that command opens (15 s, or `--wait SECONDS` first) and prints its id, app, title and geometry, with the command's pid and the file its output goes to. Two opens at once each get their own window: a window counts when it belongs to the command's own processes. The MCP tool `launch_app` does the same for an installed app.

One case can still reach your screen: an app that keeps a single copy per user (Zed, an already running browser profile) hands a second launch to the copy that is running, and if that copy is on your screen, so is the new window. `puck open` then reports no window of its own and says so. An app started fresh on the private desktop stays there.

Puck acts on the private desktop once the agent has one: in a warded worktree from the first call, in another thread from its first open, and from then on for the rest of the thread (Ward stops an idle desktop and starts it again, empty, on the next call). Until then, and outside T3, it looks at the live session, and `launch_app` refuses until the agent either has a private desktop or asks for the live session. It asks `ward desktop` each time, and if that fails it says so rather than falling back to your screen.

On a private desktop the input tools (click, type, keys, close) always work, since everything there is the agent's own. Pointer coordinates can be counted from a window's corner (`window_id`, `--window ID`), as in a screenshot of it.

An MCP server that isn't told its thread (Codex's, today) can't find a thread's desktop, so it stays on the live session, where it refuses input and `launch_app`; the `puck` CLI in the agent's shell does everything there instead.

- **MCP server:** `desktop_state` says which (`desktop`), and `desktop_state` with `desktop: "live"` moves the session to your screen (`"private"` moves it back).
- **CLI:** `puck state` says which. For an agent (in a ward or a T3 thread) it is the private desktop when there is one; `PUCK_DESKTOP=live puck …` acts on your screen. In your own terminal it follows its environment, so `ward desktop -- puck state` reads a ward's desktop from the host.

A private desktop is one 1280×720 output with no shell, so `notifications`, `dismiss_notification` and `shell_settings` refuse there, X11-only apps don't run, and `PUCK_OUTPUTS` doesn't apply. A layout snapshot restores only on the desktop it was taken on.

## Tools

| Tier | MCP tools | CLI |
|---|---|---|
| Observe | `desktop_state`, `screenshot`, `notifications`, `inspect` | `puck state`, `puck inspect …`, `puck pointer` |
| Arrange | `focus_window`, `move_window`, `arrange_windows`, `switch_workspace`, `launch_app`, `layout_snapshot`, `layout_restore`, `dismiss_notification`, `shell_settings` | `puck open CMD`, `puck snapshot`, `puck restore` |
| Invasive (on the live session only with `PUCK_INVASIVE=1`) | `close_window`, `kill_window`, `type_text`, `press_keys`, `pointer_move`, `click`, `drag`, `scroll` | `puck pointer move\|click\|drag\|scroll`, `puck keys` |

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

Text from apps without an accessibility tree is read by `tesseract` from a capture at the output's own pixels. Puck first makes text dark on white whatever its colour (red errors, a status bar, a selection), paints out ruling lines (table grids, TUI frames) and the slash in slashed zeros, and afterwards reads `O` beside digits as `0`. Terminal windows and anything with a ruled grid are read row by row; other targets keep tesseract's layout analysis, so page columns stay apart. A region cutting through a line of text returns junk for that line.

## Environment

| Variable | Effect |
|---|---|
| `PUCK_INVASIVE=1` | Lets the invasive MCP tools above act on the live session (a private desktop needs nothing) |
| `PUCK_OUTPUTS=A,B` | Mutating tools and pointer input only touch these outputs; global changes are off |

## Development

```sh
pnpm test                 # unit tests
pnpm typecheck
scripts/agentic-test.sh "On PUCK-SBX, open Zed and Helium side by side"   # real agent, sandboxed
```
