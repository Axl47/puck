# Puck design

Puck lets agents see and drive the real desktop on gaia-arch, and shows live
agent status on that desktop. It has two parts that share one repo:

1. **`puck` MCP server** (TypeScript, stdio). Wraps Umbriel's IPC, Noctalia's
   IPC, and `grim`.
2. **`puck` Noctalia plugin** (Luau). A bar widget plus a background service
   that reads T3's thread snapshot over HTTP.

## What the machine exposes

### Umbriel (compositor)

- One CLI, `umbriel`, talks to `$XDG_RUNTIME_DIR/umbriel-$WAYLAND_DISPLAY.sock`.
  The T3 service (and so every agent) runs without `WAYLAND_DISPLAY`, so Puck
  finds the socket itself (`umbriel-*.sock`, prefer `wayland-0`) and sets the
  variable for every child process.
- Every inspect command takes `--json`: `windows`, `workspaces`, `outputs`,
  `layers`, `focused-window`. Windows have stable ids (`ad56678b…`), plus
  `app_id`, `title`, `pid`, `workspace` (`DP-2:8`), `output`, geometry,
  `floating`/`fullscreen`/`minimized`, `visible`.
- `umbriel subscribe windows,workspaces,…` streams the same JSON as events.
- `umbriel msg <action>` runs any keybind action. Most act on the **focused**
  window (move, swap, resize, move-to-output); a few take `<window-id>`
  (`window-focus`, `window-close`, `window-kill`, `window-toggle-floating`,
  `window-move-to/-by --window`). So "move window X" means: focus X, act,
  then put focus back where it was.
- Layouts are per workspace: `scrolling` (current everywhere), `dwindle`,
  `master`, `stacking`. `window-set-primary-extent <fraction>` sizes columns,
  which is how "side by side, half each" is done in scrolling.
- `umbriel output-create/-destroy <name>` makes a **virtual output**. That is a
  sandbox screen agents can use without touching my monitors (see Testing).
- Input: Umbriel implements wlr virtual-keyboard and virtual-pointer. `wtype`
  (installed) types and presses keys; pointer input goes through Puck's own
  client (see Pointer). Absolute motion maps over the bounding box of all
  outputs, even for a pointer bound to one output.
- The IPC has no cursor-position query and no process start time.

### Screen capture

- `grim -o DP-2` captures an output. `grim -T <umbriel-window-id>` captures one
  window by the same id Umbriel reports, **including windows on hidden
  workspaces** (tested on Spotify on an inactive workspace).
- Native shots are 2560x1440 (or ~2270x1350 for a window). Puck asks grim
  itself for 1568 px on the long edge (`-s`, relative to logical pixels for
  outputs and regions but to the buffer for windows) and
  JPEG (`-t jpeg`), so a screenshot costs an agent ~1.6k tokens, not ~5k, with
  no image library. Full resolution is opt-in, saved to a file.

### Noctalia (shell)

- `noctalia msg` covers: `status` (JSON), wallpaper get/set/next/random per
  output, theme mode, color scheme, notification show / clear-active /
  clear-history / DND / invoke-latest, panels, settings, workspace alerts,
  volume, brightness, night light, caffeine, media.
- Notification history is `~/.local/state/noctalia/notification_history.json`.
  There is no IPC to list notifications; one is dismissed by id through the
  freedesktop D-Bus `CloseNotification`, all on screen with
  `notification-clear-active`.
- Plugins are Luau with a `plugin.toml` manifest: `[[widget]]` (bar),
  `[[service]]` (headless), `[[panel]]`, `[[desktop_widget]]`. Runtime APIs
  include `noctalia.http` (async, with headers), `noctalia.state.*` (service →
  widget), `noctalia.readFile`, `barWidget.render` (declarative `ui.*`),
  `noctalia.togglePanel`, `noctalia.runAsync`. This install supports
  **plugin API 3–34**, so the plugin targets 34.

### T3

- `t3 serve` listens on `127.0.0.1:3773`. `GET /api/orchestration/shell`
  (bearer token + `x-t3-orchestration-protocol: 2`) returns every project's
  threads in one call. Per thread: `status` (`running`, `waiting`, `queued`,
  `completed`, `failed`, …), `pendingRuntimeRequest` (non-null = waiting on me:
  approval or user input), `pullRequests[].snapshot.checksState`
  (`passing | failing | pending`).
- A read-only token comes from
  `t3 auth session issue --scope orchestration:read --scope diagnostics:read --ttl 365d --label puck --token-only`
  (`diagnostics:read` is for spend), stored at `~/.config/puck/t3-token`
  (0600, never in a repo).
- Spend is only on the WebSocket RPC `server.getUsageSummary`. The usage cache
  file is an undocumented positional format, so Puck doesn't parse it.

## MCP server

### Tiers

Tools come in three tiers. The gate is the server itself, not the harness:
T3 runs agents with permissions bypassed, so a prompt-based gate would never
fire. It's a guardrail against mistakes, not a security boundary: an agent
with a shell can run `umbriel msg` or `wtype` itself.

| Tier | On by default | Tools |
|---|---|---|
| **Observe** | yes | `desktop_state`, `screenshot`, `notifications`, `inspect` |
| **Arrange** | yes | `focus_window`, `move_window`, `arrange_windows`, `switch_workspace`, `launch_app`, `layout_snapshot`, `layout_restore`, `dismiss_notification`, `shell_settings` |
| **Invasive** | no | `close_window`, `kill_window`, `type_text`, `press_keys`, `pointer_move`, `click`, `drag`, `scroll` |

Arrange actions never destroy state; layout changes undo with a snapshot, and
`shell_settings` returns the values it replaced. Invasive tools are
registered only when `PUCK_INVASIVE=1` is in the server's env, and even then
`close_window`/`kill_window` refuse windows Puck didn't launch in that
session unless the call passes `owned_only: false`. So an agent can clean up
what it opened but can't close my Zed by accident.

- `launch_app` claims only a new window whose `app_id` matches the app, never
  whatever else appears meanwhile.
- `window-kill` ends the whole client process, and single-instance apps (Zed,
  Helium, a foot server) open new windows in the user's existing process. So
  `kill_window` also refuses when the process owns windows Puck didn't launch.
- Typing targets the focused window: input tools check focus landed on the
  named window, then re-check between chunks of text and between chords, and
  stop if the user clicked elsewhere. Focus moving to a window the input
  opened (a save dialog) is fine. They refuse while a shell surface such as
  Noctalia's control center holds the keyboard, which focused-window doesn't
  show.
- `press_keys` refuses super chords; they are compositor shortcuts (close
  window, lock, switch workspace), not app input.

Pointer input is synthetic input like typing, so it sits in the invasive
tier; reading the pointer (`inspect`) is in observe. The CLI's pointer commands
need no `PUCK_INVASIVE` (a script asks for them explicitly) but honour
`PUCK_OUTPUTS`.

### Pointer

`helpers/wl.py` is a stdlib-only Wayland client (Python because the position
probe needs to pass a shared-memory fd, which Node can't):

- **Position**: maps a transparent overlay layer surface on every output for
  ~20 ms and reads the `wl_pointer.enter` Umbriel sends to the one under the
  cursor. The app under the cursor sees the pointer leave and come back, so a
  hover-only menu can close.
- **Input**: wlr virtual-pointer: absolute motion, buttons, one wheel detent
  per frame (apps drop or cap a single large step).

`click`, `drag` and `scroll` run inside `withFocus` (desktop lock,
focus-follows-mouse paused), refuse while a shell panel holds the keyboard
(it would take the input), move to the target, check the pointer landed there
(a mismatch means the user is moving the mouse, so nothing is pressed), act,
then hand focus back and return the pointer to where it was. `pointer_move`
just moves and leaves it.

### Inspect

`inspect` (MCP) and `puck inspect … --json` (CLI) report what is at a region,
a window, or a point (default: the pointer). The JSON shape is the one
Miranda's DESIGN.md specifies; fields may be added, never renamed or dropped.

- A point is inspected through the topmost visible window holding it
  (fullscreen over floating over tiled, on the output there), or the bare
  output; a region through the window under its center.
- Process start time and executable come from `/proc`.
- `helpers/a11y.py` reads the window's AT-SPI tree (app by pid, frame by
  title): the URL of the showing web document (`DocURL` in Firefox, `URI` in
  Chromium), the deepest showing element under the point, and the text of
  showing nodes inside the target. Apps report extents relative to their
  window, so boxes are offset by the frame's origin and, outside web documents,
  scaled by window size / frame size (Chromium's UI reports at its own scale).
  The walk stops after 6000 nodes or 4 s and says so in `errors`.
- `--text auto` uses accessibility text when it is non-blank and the target
  lies within the window, OCR (`tesseract` on a native-resolution grim
  capture) otherwise.
- Failures that leave a partial answer (no accessibility tree, no pointer) are
  listed in an `errors` field rather than failing the call.

`PUCK_OUTPUTS=<output,…>` limits every mutating tool to those outputs and
disables global changes (shell settings, notifications). Tests run with it set
to a virtual output, so they can't touch the real monitors even by mistake.

### Focus

Umbriel applies most actions to the focused window **on the output under the
cursor**, so focusing alone isn't enough: Puck uses `window-focus-warp`, which
moves the cursor too. Every mutating call runs inside `withFocus`, which:

- takes a `flock` in `$XDG_RUNTIME_DIR` shared by every Puck process (each
  agent gets its own MCP server), so two agents' sequences can't interleave;
- pauses focus-follows-mouse with a runtime override so the user's mouse can't
  steal focus mid-sequence. The user's value is saved to a file first and put
  back afterwards, on SIGTERM, and, if Puck is SIGKILLed, by the `flock` child
  as soon as its parent's pipe closes;
- confirms each focus landed before acting on it (the moving or resizing
  actions have no window-id form, so this narrows, but can't close, the gap
  where a user's click redirects an action);
- afterwards puts back the visible workspace of outputs the call wasn't meant
  to change, and refocuses the user's window (or their output, if they were on
  an empty workspace). If focus ended somewhere Puck didn't put it, the user
  took over mid-call, and their changes are left alone.

The cursor ends up on the user's focused window, not where it was.

### Tool notes

- `desktop_state` returns outputs, workspaces, windows and shell settings in
  one compact call; window flags appear only when true.
- `screenshot` takes an output, a window id (works on hidden workspaces) or a
  region, and returns a JPEG scaled to 1568 px; `full_res` saves a PNG.
- `arrange_windows({ window_ids, output, layout: "split" | "master" })` moves
  the windows to a workspace on that output that holds nothing else (one
  holding only the leading windows, so order still follows `window_ids`, else
  an empty one, preferring dynamic workspaces to the user's named ones), shows it, and sets
  Umbriel's `dwindle` or `master` layout. "Zed and Helium side by side on the
  right monitor" is one call. Scrolling columns can't show two windows fully
  with `center_focused = "always"`, so there's no columns mode.
- `launch_app` resolves a desktop entry by name or id, spawns it through
  Umbriel, waits for the new window, and records it as Puck-owned. Focus goes
  back to the user's window (an agent's virtual output is invisible to them).
  Terminal apps (`Terminal=true`) are refused.
- `layout_snapshot({ outputs? })` / `layout_restore` record and put back each
  window's workspace, floating and fullscreen state and column width, each
  workspace's layout (empty ones too), the visible workspaces and focus.
  Umbriel deletes empty dynamic workspaces and renumbers the rest, so
  workspaces are stored as references: named ones by name, dynamic ones by id
  while that workspace exists, then by the windows they held. Scope snapshots
  to the outputs you'll touch so a restore can't undo the user's changes
  elsewhere; windows that have since moved off those outputs are skipped.
  Column order within a workspace isn't restored.

### Shape of the code

```
src/
  exec.ts        child processes; finds the Wayland display agents lack
  umbriel.ts     typed Umbriel client (zod over `--json`), withFocus
  noctalia.ts    `noctalia msg`, notification history, D-Bus dismiss
  capture.ts     grim, scaled and encoded by grim itself
  pointer.ts     pointer position and input, window under a point
  inspect.ts     inspect: window, process, accessibility, OCR
  apps.ts        desktop entry lookup
  arrange.ts     workspace choice for arrange_windows
  layout.ts      snapshots and restore
  scope.ts       PUCK_OUTPUTS
  t3.ts          spend over T3's WebSocket RPC
  tools/         one file per tier
  server.ts      registers tiers from env, stdio transport
  cli.ts         puck mcp | state | snapshot | restore | spend | inspect | pointer
helpers/
  wl.py          Wayland client: pointer position probe, virtual pointer
  a11y.py        AT-SPI reader for inspect
plugin/puck/     the Noctalia plugin
```

Node 22+, pnpm, `@modelcontextprotocol/sdk`, and zod. Installed as
`~/.local/bin/puck` (a symlink to `dist/cli.js`), registered by adding a
`puck` entry to indexio's `mcp/servers.json`. `mcp/sync` skips servers whose
command isn't installed, so the Mac ignores it.

### Known gaps

- Chromium's page boxes are off by up to ~10 px (its reported origin doesn't
  match its window geometry); Firefox's match.
- `close_window`, `kill_window` and a `launch_app` without a target act by
  window id outside the desktop lock; they can still shift focus under another
  agent's sequence, which that sequence's focus checks then catch.
- Window screenshots assume the client scales its buffer with the output; an
  app that doesn't (some XWayland apps) comes back smaller than reported.
- A layout set on an empty workspace isn't guaranteed to land (set-layout
  applies under the cursor); restore reports it as skipped when it didn't.

## Bar widget

```
✋1  ⟳3  ✉2  ⎇1  $51
```

One glyph and count per non-empty state: threads that need me (a pending
approval or question, accent color, subagents included), running threads,
finished threads I haven't reviewed (unsettled), open PRs (deduplicated; error
color with the failing count when checks fail), and today's spend. The tooltip
spells each out; clicking opens a panel listing the threads by section.

- **Service** (`service.luau`) polls
  `/api/orchestration/shell?omitIdleSubagents=1&omitOlderSettled=1` every 5 s
  with the token from `~/.config/puck/t3-token` and publishes a summary through
  `noctalia.state`, or an error state when T3 is unreachable, rejects the
  token, or doesn't answer within 30 s. Once a minute it runs `puck spend`,
  which makes one WebSocket call to `server.getUsageSummary`; a failure hides
  the spend rather than leave a stale figure.
- **Widget** and **panel** only render that state.

The plugin is installed from a local path source (`noctalia msg plugins source
add puck path <repo>/plugin`) and placed first in the bar's right group in
`~/.config/noctalia/gaia.toml`; both are recorded in omarchy-config.

## Testing

- **Unit**: parsers, workspace choice, snapshot math and references, desktop
  entries, key chords, against JSON captured on this machine.
- **Agentic**: `scripts/agentic-test.sh "<task>"` runs a headless Claude
  session that has only Puck's tools, with `PUCK_OUTPUTS=PUCK-SBX` and the
  invasive tier on. It creates the `PUCK-SBX` virtual output, then closes its
  windows and destroys it (an invisible output beside the monitors swallows the
  cursor). I check the result myself with `umbriel` and a screenshot of that
  output, keeping it up with `KEEP_SANDBOX=1`.
- **Pointer**: click, drag and scroll are checked live on the sandbox output
  against a test page that reports each event in its title, read back with
  `inspect` (`PUCK_OUTPUTS=PUCK-SBX` makes the CLI refuse other outputs).
- **Not disturbing the session**: anything that moves, resizes or relayouts
  runs only on a virtual output. Read-only checks (listing, screenshots) may
  use the real outputs. Creating a virtual output makes Noctalia add a
  lock-screen widget entry for it to `settings.toml`; the test script removes
  it with the output.
