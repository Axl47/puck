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
  (installed) types and presses keys. Pointer needs a small client (see
  Invasive tier).

### Screen capture

- `grim -o DP-2` captures an output. `grim -T <umbriel-window-id>` captures one
  window by the same id Umbriel reports, **including windows on hidden
  workspaces** (tested on Spotify on an inactive workspace).
- Native shots are 2560x1440 (or ~2270x1350 for a window). Puck asks grim
  itself for 1568 px on the long edge (`-s`, relative to logical pixels) and
  JPEG (`-t jpeg`), so a screenshot costs an agent ~1.6k tokens, not ~5k, with
  no image library. Full resolution is opt-in, saved to a file.

### Noctalia (shell)

- `noctalia msg` covers: `status` (JSON), wallpaper get/set/next/random per
  output, theme mode, color scheme, notification show / clear-active /
  clear-history / DND / invoke-latest, panels, settings, workspace alerts,
  volume, brightness, night light, caffeine, media.
- Notification history is `~/.local/state/noctalia/notification_history.json`.
  There is no IPC to list notifications or dismiss one by id; dismiss is
  "all active".
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
  `t3 auth session issue --scope orchestration:read --ttl 365d --label puck --token-only`,
  stored at `~/.config/puck/t3-token` (0600, never in a repo).
- Spend is only on the WebSocket RPC `server.getUsageSummary`. The usage cache
  file is an undocumented positional format, so Puck doesn't parse it.

## MCP server

### Tiers

Tools come in three tiers. The gate is the server itself, not the harness:
T3 runs agents with permissions bypassed, so a prompt-based gate would never
fire.

| Tier | On by default | Tools |
|---|---|---|
| **Observe** | yes | `desktop_state`, `screenshot`, `notifications` |
| **Arrange** | yes | `focus_window`, `move_window`, `arrange_windows`, `switch_workspace`, `launch_app`, `layout_snapshot`, `layout_restore`, `dismiss_notification`, `shell_settings` |
| **Invasive** | no | `close_window`, `kill_window`, `type_text`, `press_keys` |

Arrange actions are reversible and never destroy state. Invasive tools are
registered only when `PUCK_INVASIVE=1` is in the server's env, and even then
`close_window`/`kill_window` refuse windows Puck didn't launch in that
session unless the call passes `owned_only: false`. So an agent can clean up
what it opened but can't close my Zed by accident. Typing targets the focused
window, so it first checks focus landed on the `window_id` the call names.
Pointer input is out of v1.

`PUCK_OUTPUTS=<output,…>` limits every mutating tool to those outputs and
disables global changes (shell settings, notifications). Tests run with it set
to a virtual output, so they can't touch the real monitors even by mistake.

### Focus

Umbriel applies most actions to the focused window **on the output under the
cursor**, so focusing alone isn't enough: Puck uses `window-focus-warp`, which
moves the cursor too. Every mutating call runs inside `withFocus`, which
serializes calls, pauses focus-follows-mouse (a runtime override, dropped
afterwards) so the user's mouse can't steal focus mid-sequence, puts back the
visible workspace of outputs the call wasn't meant to change, and refocuses the
user's window when it's still on screen. The cursor does jump briefly.

### Tool notes

- `desktop_state` returns outputs, workspaces, windows and shell settings in
  one compact call; window flags appear only when true.
- `screenshot` takes an output, a window id (works on hidden workspaces) or a
  region, and returns a JPEG scaled to 1568 px; `full_res` saves a PNG.
- `arrange_windows({ window_ids, output, layout: "split" | "master" })` moves
  the windows to a workspace on that output that holds nothing else (one
  holding only these windows, else the first empty one), shows it, and sets
  Umbriel's `dwindle` or `master` layout. "Zed and Helium side by side on the
  right monitor" is one call. Scrolling columns can't show two windows fully
  with `center_focused = "always"`, so there's no columns mode.
- `launch_app` resolves a desktop entry by name or id, spawns it through
  Umbriel, waits for the new window, and records it as Puck-owned.
- `layout_snapshot({ outputs? })` / `layout_restore` record and put back each
  window's workspace, floating and fullscreen state and column width, each
  workspace's layout, the visible workspaces and focus. Workspaces are stored as
  references (named ones by name, dynamic ones by position) because Umbriel
  deletes empty dynamic workspaces and renumbers the rest. Scope snapshots to
  the outputs you'll touch so a restore can't undo the user's changes
  elsewhere. Column order within a workspace isn't restored.

### Shape of the code

```
src/
  exec.ts        child processes; finds the Wayland display agents lack
  umbriel.ts     typed Umbriel client (zod over `--json`), withFocus
  noctalia.ts    `noctalia msg`, notification history, D-Bus dismiss
  capture.ts     grim, scaled and encoded by grim itself
  apps.ts        desktop entry lookup
  arrange.ts     workspace choice for arrange_windows
  layout.ts      snapshots and restore
  scope.ts       PUCK_OUTPUTS
  t3.ts          spend over T3's WebSocket RPC
  tools/         one file per tier
  server.ts      registers tiers from env, stdio transport
  cli.ts         puck mcp | state | snapshot | restore | spend
plugin/puck/     the Noctalia plugin
```

Node 22+, pnpm, `@modelcontextprotocol/sdk`, and zod. Installed as
`~/.local/bin/puck` (a symlink to `dist/cli.js`), registered by adding a
`puck` entry to indexio's `mcp/servers.json`. `mcp/sync` skips servers whose
command isn't installed, so the Mac ignores it.

## Bar widget

```
✋1  ⟳3  ✉2  ⎇1  $51
```

One glyph and count per non-empty state: threads that need me (a pending
approval or question, accent color), running threads, finished threads I
haven't reviewed (unsettled), open PRs (error color with the failing count when
checks fail), and today's spend. The tooltip spells each out; clicking opens a
panel listing the threads by section.

- **Service** (`service.luau`) polls
  `/api/orchestration/shell?omitIdleSubagents=1&omitOlderSettled=1` every 5 s
  with the token from `~/.config/puck/t3-token` and publishes a summary through
  `noctalia.state`. Once a minute it runs `puck spend`, which makes one
  WebSocket call to `server.getUsageSummary`.
- **Widget** and **panel** only render that state.

The plugin is installed from a local path source (`noctalia msg plugins source
add puck path <repo>/plugin`) and placed first in the bar's right group in
`~/.config/noctalia/gaia.toml`; both are recorded in omarchy-config.

## Testing

- **Unit**: parsers, workspace choice, snapshot math and references, desktop
  entries, key chords, against JSON captured on this machine.
- **Agentic**: `scripts/agentic-test.sh "<task>"` runs a headless Claude
  session that has only Puck's tools, with `PUCK_OUTPUTS=PUCK-SBX` and the
  invasive tier on. It creates the `PUCK-SBX` virtual output if needed. I check
  the result myself with `umbriel` and a screenshot of that output.
- **Not disturbing the session**: anything that moves, resizes or relayouts
  runs only on a virtual output. Read-only checks (listing, screenshots) may
  use the real outputs. Creating a virtual output makes Noctalia add a
  lock-screen widget entry for it to `settings.toml`; remove it afterwards.
