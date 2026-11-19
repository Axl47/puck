# Orrery design

Orrery lets agents see and drive the real desktop on gaia-arch, and shows live
agent status on that desktop. It has two parts that share one repo:

1. **`orrery` MCP server** (TypeScript, stdio). Wraps Umbriel's IPC, Noctalia's
   IPC, and `grim`.
2. **`orrery` Noctalia plugin** (Luau). A bar widget plus a background service
   that reads T3's thread snapshot over HTTP.

## What the machine exposes

### Umbriel (compositor)

- One CLI, `umbriel`, talks to `$XDG_RUNTIME_DIR/umbriel-$WAYLAND_DISPLAY.sock`.
  The T3 service (and so every agent) runs without `WAYLAND_DISPLAY`, so Orrery
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
- Native shots are 2560x1440 (or ~2270x1350 for a window). Orrery asks grim
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
  `noctalia.togglePanel`. This install is **plugin API 35**, so the plugin
  targets 35.

### T3

- `t3 serve` listens on `127.0.0.1:3773`. `GET /api/orchestration/shell`
  (bearer token + `x-t3-orchestration-protocol: 2`) returns every project's
  threads in one call. Per thread: `status` (`running`, `waiting`, `queued`,
  `completed`, `failed`, …), `pendingRuntimeRequest` (non-null = waiting on me:
  approval or user input), `pullRequests[].snapshot.checksState`
  (`passing | failing | pending`).
- A read-only token comes from
  `t3 auth session issue --scope orchestration:read --ttl 365d --label orrery --token-only`,
  stored at `~/.config/orrery/t3-token` (0600, never in a repo).
- Spend is only on the WebSocket RPC `server.getUsageSummary`. The usage cache
  file is an undocumented positional format, so Orrery doesn't parse it.

## MCP server

### Tiers

Tools come in three tiers. The gate is the server itself, not the harness:
T3 runs agents with permissions bypassed, so a prompt-based gate would never
fire.

| Tier | On by default | Tools |
|---|---|---|
| **Observe** | yes | `desktop_state`, `screenshot`, `notifications`, `shell_status` |
| **Arrange** | yes | `focus`, `move_window`, `arrange`, `workspace`, `launch`, `layout_snapshot`, `layout_restore`, `shell` (wallpaper, theme, DND, notify, dismiss) |
| **Invasive** | no | `close_window`, `kill_window`, `type_text`, `press_keys`, `pointer` |

Arrange actions are reversible and never destroy state. Invasive tools are
registered only when `ORRERY_INVASIVE=1` is in the server's env, and even then
`close_window`/`kill_window` refuse windows Orrery didn't launch in that
session unless the call passes `owned_only: false`. So an agent can clean up
what it opened but can't close my Zed by accident. Typing and pointer actions
target the focused window, so they first check focus matches the `window_id`
the call names.

### Tool shapes (sketch)

- `desktop_state()` → outputs (name, position, scale, usable area, active
  workspace), workspaces (id, name, layout, window count), windows (id,
  app_id, title, workspace, output, geometry, flags). One call, compact JSON.
- `screenshot({ target: { output } | { window_id } | { region }, full_res? })`
  → MCP image content (+ file path when `full_res`).
- `move_window({ window_id, workspace?, output?, floating?, region? })`.
- `arrange({ output, window_ids, layout: "columns" | "rows" | "master" | "single", sizes? })`:
  moves the windows to that output's active workspace and sizes them. "Zed
  and Helium side by side on the right monitor" is one call.
- `launch({ app })`: resolves a desktop entry by name or id, runs it through
  `umbriel msg spawn`, waits for the new window, returns its id and records
  it as Orrery-owned.
- `layout_snapshot()` / `layout_restore({ snapshot_id })`: saves every window's
  workspace, output, floating state, and focus, and moves them back. Agents use
  this to leave the desktop as they found it; the agentic tests do too.

### Shape of the code

```
src/
  umbriel.ts     typed client: run `umbriel … --json`, parse with zod, socket discovery
  noctalia.ts    typed client for `noctalia msg` + notification history
  capture.ts     grim, scaled and encoded by grim itself
  tools/         one file per tier; each exports its tool definitions
  server.ts      registers tiers based on env, stdio transport
  cli.ts         `orrery mcp` (server), `orrery state` (debug dump), `orrery t3-token`
```

Node 22+, pnpm, `@modelcontextprotocol/sdk`, and zod (the SDK's own schema
library). No other runtime dependencies. Installed as `~/.local/bin/orrery`, registered
by adding an `orrery` entry to indexio's `mcp/servers.json`. `mcp/sync` skips
servers whose command isn't installed, so the Mac ignores it.

## Bar widget

```
◉ 3  ◔ 1  ✓        (3 running, 1 waiting on me, all PR checks passing)
◉ 2  ✗ 1            (a PR has failing checks: red)
```

- **Service** (`status.luau`) polls `/api/orchestration/shell?omitIdleSubagents=1&omitOlderSettled=1`
  every 5 s with the token from `~/.config/orrery/t3-token`, reduces it to
  counts plus the waiting and failing threads, and publishes that through
  `noctalia.state`.
- **Widget** (`widget.luau`) renders the counts. Zero states hide; nothing
  shows when no agent is active. "Waiting" uses the accent color, failing
  checks use the error color.
- **Panel** (`panel.luau`, opened on click) lists waiting threads and failing
  PRs by project and title.
- **Spend** (optional, last): `orrery spend --json` makes one WebSocket call to
  `server.getUsageSummary`; the service runs it once a minute if the plugin API
  allows running commands, and the widget's tooltip shows today's spend.

The plugin lives in `plugin/`, installed as a Noctalia plugin source and added
to the bar in Noctalia's config, both recorded in omarchy-config.

## Testing

- **Unit**: the zod parsers and the arrange planner, against captured JSON from
  this machine. No mocks of the compositor beyond fixtures.
- **Agentic**: Claude subagents get only the Orrery MCP tools and a desktop
  task ("put Zed and Helium side by side on the right monitor and screenshot
  it"). I check the result with my own `desktop_state` and a screenshot.
- **Not disturbing the session**: every test run starts with
  `layout_snapshot` and ends with `layout_restore`; tests only close windows
  they launched. Where a task doesn't need my monitors, tests run on a virtual
  output (`umbriel output-create ORRERY-TEST`), which isn't visible on either
  screen, and destroy it afterwards. Focus changes are the one thing that can
  still reach me mid-test, so tests restore focus at the end.

## Open questions

1. **Pointer input**: keyboard is free (`wtype`). Pointer needs either
   `wlrctl` from the AUR (relative moves only) or a ~100-line Wayland client
   for absolute moves and clicks. I'd ship keyboard first and add pointer only
   if a real task needs it.
2. **Spend in the bar**: worth one extra WebSocket client, or skip?
