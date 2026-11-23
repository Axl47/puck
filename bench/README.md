# Desktop agent benchmark

How do agents fare driving a desktop with Puck, compared with the computer use that ships in Claude desktop and Codex? Each task is a short workflow that starts in Helium on a small local site and ends with an edit in an Obsidian vault. A script judges the vault afterwards, so a run passes or fails on what ended up on disk, not on what the agent says it did.

Puck runs on Linux. Computer use (in Claude desktop and Codex) runs on the Mac. The model is the same on both sides, but the operating system and its apps differ, so read the results as "Puck vs. computer use as each ships", not as a controlled comparison of the tools alone.

## Tasks

| id | Workflow | Passes when |
| --- | --- | --- |
| `clip` | Copy a paragraph from the Field Guide page into a new note | `Lantern Rule.md` holds the paragraph word for word (quotes, dashes and line wrapping are normalized) |
| `restock` | Find every Backordered part in a 30-row table and list them as a checklist | `Restock.md` has exactly those five items, in page order |
| `dispatch` | Follow a link to Dispatch #47 and append its tracking code to a list | `Inbox.md` is unchanged apart from the new bullet |
| `signup` | Submit a form, then put the confirmation code into a note property | `Account.md`'s `confirmation` property holds the code |

Every agent gets the same text: `PREAMBLE` followed by the task's prompt, both in [tasks.ts](tasks.ts). The preamble bans terminals, file tools, browser automation and the Obsidian CLI. Banned tool calls are recorded in the transcript as `violations`.

## Running on Linux (Puck)

```sh
node bench/run.ts --client claude --model claude-sonnet-5-5 --tasks all --reps 3
node bench/run.ts --client codex  --model gpt-6.1-terra    --tasks all --reps 3
```

Run it from a ward or a T3 thread, which gives you a private desktop. For each run, the runner:

1. Serves `bench/site` at `http://localhost:8765/`.
2. Copies `bench/vault` to a fresh "Puck Bench" vault.
3. Opens Obsidian and Helium on the private desktop, each with its own new profile. It stops if either opens anywhere else.
4. Runs the agent with Puck as its only tool:
   - Claude Code: `--tools ""`, `--strict-mcp-config`, and no settings or CLAUDE.md.
   - Codex: shell, browser, plugins, subagents and web search turned off. Codex keeps its code-mode `exec`, because that is how it calls MCP tools.
5. Judges the vault and appends a row to `bench/results/runs.jsonl`.

Transcripts and final screenshots go to `bench/results/runs/<run_id>/`, which git ignores.

Effort is `medium` for every model unless `--effort` says otherwise.

## Running on the Mac (computer use)

On the Mac, computer use drives the live screen. Nobody should use the Mac during a run. Quit your own Helium and Obsidian first, so the agent can only find the benchmark's copies.

```sh
node bench/run.ts --client codex --model gpt-6.2-sol --tasks all --reps 3
node bench/run.ts --client claude-desktop --model claude-opus-5-5 --tasks all --reps 3
```

- **Codex** runs headless, through the bundled `unified-computer-use` plugin. Its `CODEX_HOME` links to your login, plugins and computer-use folder, and has its own config that turns on only that plugin, so your AGENTS.md and config stay out. Each run allows computer use to drive Helium and Obsidian for that session only (the "allow for this session" answer), since headless Codex can't ask you.
- **Claude desktop** can't be scripted. For each run, the runner opens the apps and copies the prompt to the clipboard. You then:
  1. Start a new Code session on the named model, with computer use on.
  2. Paste the prompt, and leave the Mac alone while it runs.
  3. Press Enter in the terminal once the session has finished.

  The runner then judges the vault and reads usage from the session's transcript in `~/.claude/projects`.
- **Effort:** pass `--effort` with the level the session actually uses.

## Report

The report uses agent-corpus's `viz` package:

```sh
pnpm --dir <agent-corpus>/viz render bench/results/runs.jsonl bench/report.json -o report.html
```

## Results

Each line of `bench/results/runs.jsonl` is one run, with these fields:

- Who ran it: `task`, `harness` (`puck` | `computer-use`), `platform`, `client`, `model`, `effort`, `rep`.
- Outcome: `passed`, plus `detail`, which says why a run failed.
- Effort spent: `wall_ms`, `turns`, `tool_calls`, `failed_actions` (tool calls that errored), and `screenshots` (images tools handed back to the model).
- Tokens: `input_tokens` counts every prompt token the model read, cached or not. `cache_read_tokens` and `cache_write_tokens` are the cached parts. `output_tokens` is what the model wrote.
- `context_tokens` is the first request's prompt (system prompt, tool definitions, task), which every later request carries again. `work_tokens` is `input_tokens` minus that context once per request: what the run itself added, mostly screenshots and tool results. Compare harnesses on `work_tokens`. A Claude desktop session carries about 80k tokens of context: Claude Code's tools, your MCP servers, skills and CLAUDE.md. The Linux runs carry about 10k.
- Rule-breaking: `violations` lists banned tools the agent used. Claude desktop's `ToolSearch` doesn't count, since it only loads the computer-use tools.

`turns` means different things for each client. For Claude Code it is the number of model requests. Codex reports usage per task rather than per request, so for Codex it is tool calls plus the final answer.
