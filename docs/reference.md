# Puck reference

Details behind the [README](../README.md). The design and its reasoning are in [DESIGN.md](../DESIGN.md).

## Which desktop

Puck acts on one of two desktops:

- **Private:** a headless desktop from [Ward](https://github.com/Axl47/ward) that only the agent's windows live on and you never see. It belongs to the agent's ward, or, for a [T3 Code](https://github.com/pingdotgg/t3code) thread without a ward, to the thread itself.
- **Live:** your own session, behind the guardrails in the README.

```sh
puck open ./build/my-app                    # or any command that opens a window
puck open helium http://localhost:5173      # a page of a dev server the agent already runs
```

`puck open CMD` is the one way to open something for a check. It starts the private desktop if needed, runs `CMD` on it detached, waits for the window that command opens (15 s, or `--wait SECONDS` first) and prints its id, app, title and geometry, with the command's pid and the file its output goes to. Two opens at once each get their own window: a window counts when it belongs to the command's own processes. The MCP tool `launch_app` does the same for an installed app.

One case can still reach your screen: an app that keeps a single copy per user (Zed, an already running browser profile) hands a second launch to the copy that is running, and if that copy is on your screen, so is the new window. `puck open` then reports no window of its own and says so. An app started fresh on the private desktop stays there.

Puck acts on the private desktop once the agent has one: in a warded worktree from the first call, in another thread from its first open, and from then on for the rest of the thread (Ward stops an idle desktop and starts it again, empty, on the next call). Until then, and outside T3 Code, it looks at the live session, and `launch_app` refuses until the agent either has a private desktop or asks for the live session. It asks `ward desktop` each time, and if that fails, or answers "none" for a thread that had a desktop, or names your session, it says so rather than falling back to your screen.

On a private desktop the input tools (click, type, keys, close) always work, since everything there is the agent's own. Pointer coordinates can be counted from a window's corner (`window_id`, `--window ID`): on a private desktop, the pixels of a screenshot of it.

An MCP server that isn't told its thread (Codex's, today) can't find a thread's desktop, so it stays on the live session, where it refuses input and `launch_app`; the `puck` CLI in the agent's shell does everything there instead.

- **MCP server:** `desktop_state` says which (`desktop`), and `desktop_state` with `desktop: "live"` moves the session to your screen (`"private"` moves it back).
- **CLI:** `puck state` says which. For an agent (in a ward or a T3 Code thread, told by its environment, a parent process's, or T3 Code's agents' cgroup) it is the private desktop when there is one; `PUCK_DESKTOP=live puck …` acts on your screen. Input commands reach your screen only from your own terminal (one your session started, or a login) or with `PUCK_DESKTOP=live`; anything else, such as a service, can look but not act. In your own terminal it follows its environment, so `ward desktop -- puck state` reads a ward's desktop from the host.

A private desktop is one 1280×720 output with no shell, so `notifications`, `dismiss_notification` and `shell_settings` refuse there, X11-only apps don't run, and `PUCK_OUTPUTS` doesn't apply. A layout snapshot restores only on the desktop it was taken on.

## CLI

```sh
puck inspect (--region X,Y,WxH | --window ID | --point X,Y | --pointer) \
             [--text auto|accessibility|ocr|none] [--screenshot PATH] --json
puck pointer                               # what is under the pointer
puck pointer move X,Y
puck pointer click [X,Y] [--button left|right|middle] [--count N] [--overlay NS]
puck pointer drag X,Y X,Y [--button …] [--overlay NS]
puck pointer scroll [X,Y] [--dx N] [--dy N] [--overlay NS]   # wheel steps; --dy=-3 scrolls up
puck keys (--window ID | --overlay NS) CHORD…              # e.g. ctrl+l Return, Escape
puck type --window ID TEXT
puck spend                                 # today's agent spend from T3 Code, as JSON
```

Coordinates are global logical pixels, as `puck state` reports them, or counted from a window's corner with `--window ID`. Write negative values as `--point=-10,20`, and put `--` before negative positionals. Click, drag and scroll put the pointer and focus back afterwards.

## Pickers and overlays

Input is refused while a shell surface (launcher, panel, picker) has the keyboard, since it would take input meant for a window. To drive a picker on purpose, name its layer-shell namespace: `--overlay selection` for slurp, or `overlay: "selection"` on the MCP `click`, `drag`, `scroll` and `press_keys` tools (`press_keys` then takes no `window_id`). Input goes ahead only while that overlay has the keyboard and lies under every point. `PUCK_OUTPUTS` still applies.

```sh
printf '3292,46 1418x843 editor\n' | slurp &   # a picker over window boxes
puck pointer click 3500,300 --overlay selection   # slurp prints 3292,46 1418x843
puck keys --overlay selection Escape              # or cancel it
```

## Which windows are on screen

`puck state` and `desktop_state` give every window its `output`, `workspace_active` (its workspace is the one shown on that output) and `on_screen`: the part of its rectangle on that output, or `null` when it's hidden, minimized or in a scrolled-away column. Trust `on_screen` to decide what the user can see or click. `x`/`y`/`width`/`height` are the window's full layout rectangle, which for scrolled columns lies off its output, and Umbriel's `visible` stays true for them.

## Accessibility text and page URLs

Apps only expose their accessibility tree when AT-SPI is switched on (`org.a11y.Status IsEnabled`; the gsettings key alone doesn't guarantee it). `inspect` switches it on when it's off and says so in `errors`. Browsers decide when they start:

- **Zen and other Firefox-based browsers** register as soon as it is on, even if already running. The page URL comes from the document's `DocURL` attribute.
- **Helium and other Chromium-based browsers** check only at launch: restart them once after switching it on (or launch with `--force-renderer-accessibility`). The page URL comes from the document's `URI` attribute.

Apps without a tree (foot, most games, images) get OCR instead.

## OCR

Text from apps without an accessibility tree is read by `tesseract` from a capture at the output's own pixels. Puck first makes text dark on white whatever its colour (red errors, a status bar, a selection), paints out ruling lines (table grids, TUI frames) and the slash in slashed zeros, and afterwards reads `O` beside digits as `0`. Terminal windows and anything with a ruled grid are read row by row; other targets keep tesseract's layout analysis, so page columns stay apart. A region cutting through a line of text returns junk for that line.

## Environment

| Variable | Effect |
|---|---|
| `PUCK_INVASIVE=1` | Lets the invasive MCP tools act on the live session (a private desktop needs nothing) |
| `PUCK_OUTPUTS=A,B` | Mutating tools and pointer input only touch these outputs; global changes are off |
| `PUCK_DESKTOP=live` | CLI acts on your session instead of the agent's private desktop |
| `PUCK_ACTIVITY_DIR` | Where activity records go and the recorder's `on` file is read (default `$XDG_RUNTIME_DIR/ward/activity`) |

## Activity records

While a recorder on the host is on (it keeps `$XDG_RUNTIME_DIR/ward/activity/on` fresh), each MCP tool call leaves a small JSON record in that folder: the tool, timing, outcome, desktop, and sanitized arguments. Typed text, pixels and captured text are never recorded. Wards can't see the folder, and `PUCK_ACTIVITY_DIR` overrides it.
