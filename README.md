<img src="assets/icon.svg" width="64" height="64" alt="">

# Puck

Puck lets AI agents see and operate desktop apps on Linux. An agent can take screenshots, read the text on screen, click, type and arrange windows. It works on a private desktop you never see, so the agent can test an app while you keep working, or on your real screen with guardrails. It also shows live agent status in your desktop bar.

Agents reach it as an [MCP](https://modelcontextprotocol.io) server or through the `puck` command line.

![A release checklist page before and after an agent filled it in](docs/images/demo.png)

An agent opened this page on its private desktop, typed a version, ticked the last box and clicked **Ship it**:

```sh
$ puck open helium-browser --app=http://localhost:8765/
{ "desktop": "private", "window": { "id": "4b4a6520…", "title": "localhost", "width": 1249, "height": 701, … } }

$ puck pointer click 600,297 --window 4b4a6520…     # the Version field
$ puck type --window 4b4a6520… 1.4.0
$ puck pointer click 410,413 --window 4b4a6520…     # Docs reviewed
$ puck pointer click 445,476 --window 4b4a6520…     # Ship it

$ puck inspect --window 4b4a6520… --json
{
  "desktop": "private",
  "window": {
    "app_id": "chrome-localhost__-Default",
    "title": "Release checklist",
    "exe": "/opt/helium-browser-bin/helium",
    "url": "http://localhost:8765/",
    …
  },
  "text": {
    "source": "accessibility",
    "content": "Shipped 1.4.0\nVersion\n1.4.0\nShip it"
  }
}
```

`inspect` reads text from the app's accessibility tree when it has one, and falls back to OCR (for terminals, games, images) when it doesn't.

## Your screen or a private one

**Private desktop.** [Ward](https://github.com/Axl47/ward) gives each agent its own headless desktop. `puck open CMD` starts it if needed, runs the command there and prints the window it opened. Everything on it belongs to the agent, so clicking, typing and closing windows always work.

**Your screen.** Agents can look freely, but anything that could disrupt you is held back:

- Clicking, typing and closing windows are off unless you start the server with `PUCK_INVASIVE=1`.
- Input is refused while a launcher, panel or picker has the keyboard, so keystrokes can't land in the wrong place.
- `PUCK_OUTPUTS=DP-2` keeps the agent on the monitors you name.
- An agent can snapshot your window layout before rearranging it and put it back afterwards.

If Puck can't tell for certain which desktop an agent should use, it refuses rather than falling back to your screen.

## Tools

| Tier | MCP tools | CLI |
|---|---|---|
| Observe | `desktop_state`, `screenshot`, `inspect`, `notifications` | `puck state`, `puck inspect`, `puck pointer` |
| Arrange | `launch_app`, `focus_window`, `move_window`, `arrange_windows`, `switch_workspace`, `layout_snapshot`, `layout_restore`, `dismiss_notification`, `shell_settings` | `puck open`, `puck snapshot`, `puck restore` |
| Invasive | `click`, `drag`, `scroll`, `pointer_move`, `type_text`, `press_keys`, `close_window`, `kill_window` | `puck pointer click\|drag\|scroll\|move`, `puck type`, `puck keys`, `puck focus` |

Screenshots are scaled to about 1,600 px on the long edge, so one costs an agent around 1.6k tokens.

## Puck vs. computer use

A quick test, not a benchmark. Four models each did four short workflows that start in Helium and end with an edit in an Obsidian vault. Each model ran once with Puck on Linux and once with the computer use that ships in Claude desktop or Codex, on macOS. All 80 runs passed. The figures are medians per run, except failed actions, which are an average.

| Model | Time, Puck | Time, computer use | Work tokens, Puck | Work tokens, computer use | Failed actions, Puck | Failed actions, computer use |
|---|---|---|---|---|---|---|
| Claude Sonnet 5.5 | 21 s | 36 s | 94k | 132k | 0.1 | 3 |
| Claude Opus 5.5 | 41 s | 1 m 32 s | 77k | 532k | 0 | 3 |
| GPT-6.1 Terra | 38 s | 31 s | 107k | 110k | 0.3 | 0.3 |
| GPT-6.2 Sol | 38 s | 52 s | 129k | 302k | 0.5 | 0 |

Work tokens are the prompt tokens a run added on top of its fixed context (system prompt, tool definitions and task), counted for every model request. A failed action is a tool call that returned an error.

### How the two sides differ

- **Runs.** Puck and Codex computer use: 12 runs per model (3 of each task). Claude desktop: 4 per model (1 of each), because each one was started by hand.
- **Operating system.** Puck drove a private 1280×720 desktop on Linux. Computer use drove the Mac's live screen. Both used Helium and Obsidian, but each OS has its own builds and window behaviour, so the OS differs along with the tool.
- **Harness.**
  - Claude with Puck: headless Claude Code with Puck as its only tool and no settings or CLAUDE.md, so about 10k tokens of fixed context.
  - Claude desktop: a Code session that carries Claude Code's own tools, the user's MCP servers, skills and CLAUDE.md, about 80k tokens on every request. That is why the table compares work tokens, not total input. Total input was 6–10× higher on Claude desktop.
  - Codex: the same `codex exec` setup on both sides, with one tool server: Puck on Linux, the bundled `unified-computer-use` plugin on the Mac.
- **Instructions.** Every agent got the same task prompt, which bans terminals, file tools and browser automation. Each tool server adds its own usage instructions.
- **Timing.** The runner times Puck and Codex runs from process start to exit. Claude desktop runs are timed from the first to the last line of the session transcript, which leaves out startup and slightly favours computer use.

The tasks, runner and raw results are in [bench/](bench/README.md).

## Requirements

Puck is built for one desktop stack and talks to it directly:

- [Umbriel](https://aur.archlinux.org/packages/umbriel-git), a Wayland compositor, with `grim` for screenshots and `wtype` for typing
- [Noctalia](https://aur.archlinux.org/packages/noctalia), a desktop shell, for the bar widget, notifications and shell settings
- [Ward](https://github.com/Axl47/ward) for private desktops
- Node 22+ and pnpm
- `python3` with `python-gobject` and `at-spi2-core` for accessibility text, and `tesseract` with English data for OCR

## Setup

```sh
pnpm install && pnpm build
ln -sf "$PWD/dist/cli.js" ~/.local/bin/puck
```

Register `puck mcp` as a stdio MCP server in your agent, for example:

```sh
claude mcp add puck -- puck mcp
```

### Bar widget

The widget shows what your [T3 Code](https://github.com/pingdotgg/t3code) agents are doing. It needs a read-only T3 Code token:

```sh
mkdir -p ~/.config/puck && umask 077
t3 auth session issue --scope orchestration:read --scope diagnostics:read \
  --ttl 365d --label puck --token-only > ~/.config/puck/t3-token

noctalia msg plugins source add puck path "$PWD/plugin"
noctalia msg plugins enable axl47/puck
# then add "axl47/puck:status" to a bar section, e.g. bar.default.end
```

## More

- [docs/reference.md](docs/reference.md): how Puck picks a desktop, the full CLI, pickers, OCR, accessibility setup for browsers, environment variables
- [DESIGN.md](DESIGN.md): how it works and why

## Development

```sh
pnpm test
pnpm typecheck
scripts/agentic-test.sh "On PUCK-SBX, open Zed and Helium side by side"   # a real agent in a sandbox
```
