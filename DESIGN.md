# Puck design

Puck lets agents see and drive a desktop on gaia-arch: the real one, or the
agent's own private one. It also shows live agent status on the real
desktop. It has two parts that share one repo:

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

### Which desktop

Goal (2026-11-19): parallel agents drive and check GUI apps without fighting over
the one live session and its cursor. [Ward](https://github.com/Axl47/ward) gives
a T3 worktree a private desktop for that: a headless Umbriel on a session bus
and `XDG_RUNTIME_DIR` of its own, with no shell. Ward's `docs/DESIGN.md`
("Desktops") has how it is built; this is how Puck picks.

Puck acts on the desktop its child processes' environment names
(`XDG_RUNTIME_DIR`, `WAYLAND_DISPLAY`, `UMBRIEL_SOCKET`,
`DBUS_SESSION_BUS_ADDRESS`): `umbriel`, `grim`, the Wayland helper and AT-SPI
all find their sockets through those, and so does Puck's own lock (below).
`exec.ts` picks that environment once per MCP tool call or CLI command
(`onDesktop`), and everything the call runs gets it, so a call can't start on one
desktop and finish on another when a second call switches, or when the ward
restarts under it.

- **For an agent with a private desktop, that desktop.** Puck runs `ward desktop` in
  its own folder: exit 0 prints the private desktop's environment (a shell script
  reading two files, about 10 ms), exit 3 means there is none, and a
  missing `ward` means the machine has no Ward (an error inside a ward, where it
  can't be missing); both of those are the live session. In a warded worktree
  Ward starts the ward and its desktop for that call. In any other T3 thread the
  desktop is the thread's own, and Ward only answers once the thread has opened
  something on it, so a thread working on the user's real desktop stays there. Any other failure is reported to the agent, not papered over with
  the live session: that would put its windows on the user's screen. The MCP
  server always asks (it is one process outside the ward for the whole thread,
  so nothing could prefix its calls); the CLI asks when an agent runs it
  (`WARD_ID` or `T3CODE_THREAD_ID` is set), whose shell still has the live session's
  environment, so a bare `puck pointer click` would otherwise land on the
  user's screen.
- **Otherwise the live session,** or whatever the environment names: the CLI
  in the user's own terminal is an ordinary Wayland program, so `ward desktop -- puck state`
  from the host reads that ward's desktop.
- **`puck open -- CMD` puts something there.** Goal (2026-11-19): one standard
  command to open an app or window for a check, which the user never sees and
  which leaves the agent nothing to work out: no desktop to pick, no window id
  to find first. It runs `ward desktop -- true`, which starts the private
  desktop where a ward or a T3 thread can have one (exit 3: neither, and it
  refuses), then `ward desktop -- CMD` detached with its output in a log file,
  and polls for a window that wasn't there before. It prints that window (id,
  app, title, geometry), the command's pid and the log; a command that fails
  first is reported with the end of its output, and one that outlasts the wait
  (15 s, `--wait`) is left running. It is CLI-only on purpose: every agent has a
  shell, the command's output and lifetime are a shell's business, and the MCP
  tools then act on the same desktop. `launch_app` stays for installed apps on
  whichever desktop Puck is on.

`desktop_state` reports which one (`desktop: "private" | "live"`) and takes the
same field to move the session, for when the user wants something on their own
screen; `PUCK_DESKTOP=live` does the same for one CLI command. The
switch applies to calls that start after it, and it is per MCP server, so
subagents sharing the server share it; `desktop_state` itself picks after
switching, so `desktop: "live"` still works when the private desktop won't start.
`PUCK_OUTPUTS` names the user's monitors, so it limits nothing on a private
desktop. A layout snapshot records the desktop it was taken on (its
`XDG_RUNTIME_DIR`) and restores only there: every private desktop has the same
output and workspace names, so one would otherwise apply anywhere. `puck spend`
and `puck help` touch no desktop and start none.

A private desktop has no Noctalia: `desktop_state` gives `shell: null`, and
`notifications`, `dismiss_notification` and `shell_settings` refuse there
instead of reading or changing the user's shell. `launch_app` needs nothing
special: Umbriel starts the program, and the ward's Umbriel runs inside the
ward, so the app can reach the ward's `localhost` ports. X11-only apps don't
run there (no Xwayland).

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
- A picker overlay (slurp's `selection`) is sometimes exactly what an agent
  means to drive. `overlay: "<namespace>"` on `click`, `drag`, `scroll` and
  `press_keys` (`--overlay` on the CLI) allows input into that one namespace:
  pointer input only if a mapped surface of it lies under every point and no
  other surface has the keyboard; keys only if it has the keyboard and, under
  `PUCK_OUTPUTS`, its client shows it on an allowed output. Without it, the
  refusal stands.

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

`click`, `drag` and `scroll` first refuse targets outside `PUCK_OUTPUTS` and
calls while a shell panel holds the keyboard (it would take the input), unless
it's the overlay the call names. Then,
inside `withFocus` (desktop lock, focus-follows-mouse paused), they move to the
target, check the pointer landed on exactly that pixel (a mismatch means the
user is moving the mouse, so nothing is pressed), act, hand focus back and
return the pointer to where it was, still under the lock (unless the user
took over focus meanwhile). Input into an overlay usually closes it, and
Umbriel then focuses the window under the pointer; so Puck waits up to a second
for the overlay to unmap and then hands focus back as usual. If it stays open,
it keeps the keyboard and focus is left alone; the pointer goes back either
way. `pointer_move` takes
the lock, moves, and leaves the pointer there. Position probes take the lock
too, so a probe's overlay can't catch another Puck's click.

### Inspect

`inspect` (MCP) and `puck inspect … --json` (CLI) report what is at a region,
a window, or a point (default: the pointer). The JSON shape is the one
Miranda's DESIGN.md specifies; fields may be added, never renamed or dropped.

- A point is inspected through the topmost visible window holding it
  (fullscreen over floating over tiled, on the output there), or the bare
  output; a region through the window under its center.
- Process start time and executable come from `/proc`.
- Before reading, `inspect` makes sure AT-SPI is on (`org.a11y.Status
  IsEnabled`, one D-Bus call), switching it on and saying so in `errors` when
  it was off: it can be off despite the gsettings key, and Chromium-based
  browsers only notice at launch.
- `helpers/a11y.py` reads the window's AT-SPI tree (app by pid, frame by
  title): the URL of the showing web document (`DocURL` in Firefox, `URI` in
  Chromium), the deepest showing element under the point, and the text of
  showing nodes inside the target. Apps report extents relative to their
  window, so boxes are offset by the frame's origin and scaled: outside web
  documents by window size / frame size (Chromium's UI reports at its own
  scale); inside, Firefox reports logical pixels and Chromium the output's
  physical ones (its document is then wider than the window), divided by the
  output scale.
  The walk stops after 6000 nodes or 4 s and says so in `errors`.
- For a region, text of a node crossing its edge is cut to the characters
  between the region's corners (reading order); when the app can't place
  them, `auto` falls back to OCR. Chromium builds its tree only after an AT
  asks for attributes, so the helper asks first and re-reads once if empty.
- `--text auto` uses accessibility text when it is non-blank and the target
  lies within the window, OCR otherwise (see OCR).
- Failures that leave a partial answer (no accessibility tree, no pointer) are
  listed in an `errors` field rather than failing the call.

### OCR

`tesseract` reads a grim capture at the output's own pixels (PPM, so Puck can
process it without an image library, `src/ocr.ts`):

1. Dark text on white (what tesseract's models are trained on), whatever the
   colours: each pixel's darkness is its colour's distance from the
   background's (the commonest colour), doubled, past a floor of 10 that
   absorbs wallpaper behind a translucent terminal. Luma with Otsu put foot's
   red (113, on a background of 37) on the background's side once the
   threshold rose, as in a fullscreen terminal: gcc's `error:` vanished.
   Solid blocks of another colour (status bars, selections, inverse video,
   badges) are inked against their own colour, or they'd read as slabs: only
   their footprint (their pixels and the gaps among them a glyph-sized square
   can't fit into), so text beside a selection that starts mid-row is kept.
   Where a selection fills most of a region it becomes the paper, and the
   terminal's background, large enough, counts as the block.
2. Ruling lines painted out: components clearly darker than the paper, at
   least three glyphs long, and sparse (a grid) or thin (a rule). Read as one
   block (4), a table with its grid left in lost its cells entirely.
3. Slashed zeros made plain: a glyph-sized component with one hole above
   another and both outer sides unbroken between them (`8` and `B` pinch at
   the waist, `@` nests its holes) loses everything between its sides.
   Iosevka, foot's font here, slashes its zeros, and tesseract read them as
   `@`, `8` or `B`.
4. Terminal windows and anything with a ruled grid are read with `--psm 6`,
   one block row by row. Tesseract's own layout analysis read them column by
   column and garbled short lines; on pages it keeps columns apart, so it
   stays the default elsewhere.
5. `O` beside a digit in a word with two or more digits, and in `0x` literals,
   becomes `0`.

Each step was kept because it improved character error rate, intact lines or
key tokens (error codes, hashes, hex) on a labelled set captured here: foot
on the dark theme at 1.6 scale, a light web page, 12 px UI text, a two-column
page and a bordered table, whole and as regions; and in foot, windowed and
fullscreen, gcc and rustc errors, `ls`, `git diff` and `grep` in colour, and
coloured backgrounds (a status bar, a selection, badges, inverse video). Left out: upscaling,
`tessdata_best` and `tessdata_fast` (no measurable gain), capturing at logical
size (worse). A full terminal window reads in about 1 s.

`PUCK_OUTPUTS=<output,…>` limits every mutating tool to those outputs and
disables global changes (shell settings, notifications). Tests run with it set
to a virtual output, so they can't touch the real monitors even by mistake.

### Focus

Umbriel applies most actions to the focused window **on the output under the
cursor**, so focusing alone isn't enough: Puck uses `window-focus-warp`, which
moves the cursor too. Every mutating call runs inside `withFocus`, which:

- takes a `flock` in the desktop's `$XDG_RUNTIME_DIR` shared by every Puck
  process on that desktop (each agent gets its own MCP server), so two agents'
  sequences can't interleave; a ward's desktop has its own;
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
  one compact call; window flags appear only when true. Each window has its
  `output`, `workspace_active`, and `on_screen`: its rectangle clipped to its
  output, null when its workspace isn't shown, it's minimized or it sits in a
  scrolled-away column. Umbriel keeps `visible` true for those columns, and
  their rectangles lie off their output (even over another monitor).
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
  exec.ts        child processes; which desktop (a ward's or the live one) and its environment
  umbriel.ts     typed Umbriel client (zod over `--json`), withFocus
  noctalia.ts    `noctalia msg`, notification history, D-Bus dismiss
  capture.ts     grim, scaled and encoded by grim itself
  pointer.ts     pointer position and input, window under a point, on-screen rects
  keys.ts        key chords into a window or a shell overlay
  inspect.ts     inspect: window, process, accessibility, OCR
  ocr.ts         image preparation for OCR
  apps.ts        desktop entry lookup
  arrange.ts     workspace choice for arrange_windows
  layout.ts      snapshots and restore
  scope.ts       PUCK_OUTPUTS
  t3.ts          spend over T3's WebSocket RPC
  tools/         one file per tier
  server.ts      registers tiers from env, stdio transport
  cli.ts         puck mcp | state | snapshot | restore | spend | inspect | pointer | keys
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
  Overlay input is checked against a real `slurp`, whose output shows what
  it received.
- **OCR**: changes are scored against the labelled set (character error rate,
  intact lines, key tokens) before they are kept; unit tests hold a few real
  captured rows (slashed zeros, look-alikes, a table grid, gcc's red error,
  coloured blocks).
- **Not disturbing the session**: anything that moves, resizes or relayouts
  runs only on a virtual output. Read-only checks (listing, screenshots) may
  use the real outputs. Creating a virtual output makes Noctalia add a
  lock-screen widget entry for it to `settings.toml`; the test script removes
  it with the output.
