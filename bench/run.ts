// Runs benchmark tasks with an agent driving the desktop, and appends one row
// per run to bench/results/runs.jsonl. See bench/README.md.
//
// Linux (Puck, on a private desktop):
//   node bench/run.ts --client claude --model claude-sonnet-5-5 --tasks all --reps 3
//   node bench/run.ts --client codex --model gpt-6.1-terra --tasks clip,signup
// macOS (computer use, on the live screen):
//   node bench/run.ts --client codex --model gpt-6.2-sol
//   node bench/run.ts --client claude-desktop --model claude-opus-5-5   (a person pastes each prompt)
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { extname, join, normalize } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { claudeSessionUsage, claudeUsage, codexUsage, type Usage } from "./metrics.ts";
import { PREAMBLE, SITE, TASKS, task as findTask, type Task } from "./tasks.ts";

const BENCH = import.meta.dirname;
const RESULTS = join(BENCH, "results");
const PUCK = process.env.PUCK_BIN ?? "puck";
const MAC = process.platform === "darwin";

const { values: args } = parseArgs({
  options: {
    client: { type: "string" },
    model: { type: "string" },
    effort: { type: "string", default: "medium" },
    tasks: { type: "string", default: "all" },
    reps: { type: "string", default: "1" },
    "first-rep": { type: "string", default: "1" },
    "timeout-min": { type: "string", default: "15" },
  },
});

// Puck drives Linux; on the Mac the clients' own computer use does. Claude Code
// has no computer use of its own, so on the Mac Claude runs in Claude desktop.
const CLIENTS = MAC ? (["codex", "claude-desktop"] as const) : (["claude", "codex"] as const);
type Client = "claude" | "codex" | "claude-desktop";
const isClient = (c: string | undefined): c is Client => CLIENTS.some((k) => k === c);
if (!isClient(args.client) || !args.model) {
  console.error(`usage: node bench/run.ts --client ${CLIENTS.join("|")} --model MODEL [--effort medium] [--tasks all|id,id] [--reps N] [--first-rep N]`);
  process.exit(2);
}
const client = args.client;
const model = args.model;
const effort = args.effort;
const tasks = args.tasks === "all" ? TASKS : args.tasks.split(",").map(findTask);
const firstRep = Number(args["first-rep"]);
const lastRep = firstRep + Number(args.reps) - 1;
const timeoutMs = Number(args["timeout-min"]) * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Row = Omit<Usage, "final_message"> & {
  run_id: string;
  started_at: string;
  task: string;
  harness: "puck" | "computer-use";
  platform: "linux" | "macos";
  client: "claude-code" | "claude-desktop" | "codex";
  model: string;
  effort: string;
  /** `input_tokens` minus `context_tokens` per request: the prompt tokens the work added, not the harness's fixed context. */
  work_tokens: number | null;
  rep: number;
  passed: boolean;
  detail: string;
  wall_ms: number;
};

/** Serves bench/site on the port SITE names. */
function serveSite(): Promise<Server> {
  const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript" };
  const server = createServer((req, res) => {
    let path = normalize(decodeURIComponent(new URL(req.url ?? "/", SITE).pathname)).replace(/^(\.\.[/\\])+/, "");
    if (path.endsWith("/")) path += "index.html";
    try {
      const body = readFileSync(join(BENCH, "site", path));
      res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" }).end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((resolve) => server.listen(Number(new URL(SITE).port), "127.0.0.1", () => resolve(server)));
}

const puck = (...argv: string[]) => {
  const out = spawnSync(PUCK, argv, { encoding: "utf8" });
  if (out.status !== 0) throw new Error(`puck ${argv.join(" ")}: ${out.stderr || out.stdout}`);
  return out.stdout;
};

const APPS = `user-data-dir=${RESULTS}/runs/`;
const appsLeft = () => (MAC ? spawnSync("pgrep", ["-f", APPS]).status === 0 : (JSON.parse(puck("state")) as { windows: unknown[] }).windows.length > 0);

/**
 * Ends every app a previous run left, found by its run directory in the command
 * line, and waits for them to be gone: a window left over from another run
 * would show the agent that run's work. An agent may also relaunch an app
 * itself, without the run's profile; in a ward, every Helium and Obsidian
 * (Electron) process in the ward's cgroup is the benchmark's, so those go too.
 */
async function killApps() {
  spawnSync("pkill", ["-f", APPS]);
  const cgroup = !MAC && process.env.WARD_ID ? readFileSync("/proc/self/cgroup", "utf8").match(/^0::(.*)$/m)?.[1] : undefined;
  if (cgroup) spawnSync("pkill", ["--cgroup", cgroup, "-x", "helium|electron"]);
  for (let i = 0; i < 40 && appsLeft(); i++) await sleep(250);
  if (appsLeft()) throw new Error(MAC ? "benchmark apps still running" : `windows still open on the private desktop: ${puck("state")}`);
}

/**
 * A fresh vault, Obsidian profile and Helium profile under the run directory,
 * then Obsidian and Helium open with Helium in front: on Linux on the private
 * desktop, on the Mac as new instances beside any the user has open.
 */
async function prepare(dir: string) {
  const vault = join(dir, "Puck Bench");
  cpSync(join(BENCH, "vault"), vault, { recursive: true });
  const obsidian = join(dir, "obsidian");
  const helium = join(dir, "helium");
  mkdirSync(obsidian, { recursive: true });
  writeFileSync(join(obsidian, "obsidian.json"), JSON.stringify({ vaults: { puckbench0000001: { path: vault, ts: Date.now(), open: true } } }));
  await killApps();
  const heliumArgs = [`--user-data-dir=${helium}`, "--no-first-run", "--no-default-browser-check", SITE];
  if (MAC) {
    spawnSync("open", ["-na", "Obsidian", "--args", `--user-data-dir=${obsidian}`]);
    await sleep(6000);
    spawnSync("open", ["-na", "Helium", "--args", ...heliumArgs]);
    await sleep(5000);
    return vault;
  }
  // A run must never open on the user's screen: stop unless each app got a window on the private desktop.
  const open = (...cmd: string[]) => {
    const out = JSON.parse(puck("open", "--wait", "30", "--", ...cmd)) as { desktop: string; window: { id: string } | null; note?: string };
    if (out.desktop !== "private" || !out.window) throw new Error(`${cmd[0]} did not open on the private desktop: ${JSON.stringify(out)}`);
    return out.window.id;
  };
  open("obsidian", `--user-data-dir=${obsidian}`);
  puck("focus", open("helium-browser", ...heliumArgs));
  return vault;
}

/**
 * A Codex home with nothing of the user's but their login (and, on the Mac,
 * the computer-use plugin): the global AGENTS.md, skills and config would
 * otherwise reach the model, and Claude runs get none of the user's
 * instructions either. auth.json is a symlink, so a token refresh that
 * replaces it instead of writing through would leave the user's own login
 * stale; checkCodexHome stops the benchmark if that happens.
 */
const CODEX_HOME = join(homedir(), ".cache", "puck-bench", "codex-home");
const USER_CODEX = join(homedir(), ".codex");
function codexHome() {
  mkdirSync(join(CODEX_HOME, ".tmp"), { recursive: true });
  const shared = MAC ? ["auth.json", "plugins", "computer-use", ".tmp/bundled-marketplaces"] : ["auth.json"];
  for (const name of shared) if (!existsSync(join(CODEX_HOME, name))) symlinkSync(join(USER_CODEX, name), join(CODEX_HOME, name));
  // Codex finds plugins only through a marketplace named in config.toml (not
  // through -c) whose root is inside CODEX_HOME. Approval for a plugin's MCP
  // server goes under the plugin: a top-level mcp_servers.cua_repl entry would
  // be a second server with no command. Headless Codex refuses MCP calls that
  // need approval, and cua_repl's `js` tool is every input action.
  if (MAC)
    writeFileSync(join(CODEX_HOME, "config.toml"), [
      `[marketplaces.openai-bundled]`, `source_type = "local"`, `source = ${JSON.stringify(join(CODEX_HOME, ".tmp/bundled-marketplaces/openai-bundled"))}`, ``,
      `[plugins."unified-computer-use@openai-bundled"]`, `enabled = true`, ``,
      `[plugins."unified-computer-use@openai-bundled".mcp_servers.cua_repl]`, `default_tools_approval_mode = "approve"`, ``,
    ].join("\n"));
  checkCodexHome();
  return CODEX_HOME;
}
function checkCodexHome() {
  if (!lstatSync(join(CODEX_HOME, "auth.json")).isSymbolicLink())
    throw new Error(`${CODEX_HOME}/auth.json is no longer a link to ${USER_CODEX}/auth.json: Codex refreshed its login there. Move it over the user's so their login stays current.`);
}

// This harness may run inside a ward or a T3 thread; the child agent must not
// inherit the parent Claude Code session's wiring.
const childEnv = () => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("CLAUDE_CODE_") || key === "CLAUDECODE" || key === "CLAUDE_PID") delete env[key];
  if (client === "codex") env.CODEX_HOME = codexHome();
  return env;
};

/** The command that runs one agent on one prompt, writing its JSON stream to stdout. */
function agentCommand(prompt: string, dir: string): string[] {
  if (client === "claude") {
    const mcp = join(dir, "mcp.json");
    writeFileSync(mcp, JSON.stringify({ mcpServers: { puck: { type: "stdio", command: PUCK, args: ["mcp"] } } }));
    return ["claude", "-p", "--model", model, "--effort", effort, "--setting-sources", "", "--tools", "", "--strict-mcp-config", "--mcp-config", mcp, "--allowedTools", "mcp__puck__*", "--no-session-persistence", "--output-format", "stream-json", "--verbose", prompt];
  }
  // Everything that isn't driving the desktop is off. Code mode's `exec` stays:
  // it is how Codex calls any tool, MCP ones included.
  const off = ["shell_tool", "unified_exec", "apps", "remote_plugin", "browser_use", "browser_use_external", "in_app_browser", "image_generation", "multi_agent", "goals", "sleep_tool", "skill_search", "tool_suggest", "daemon_auto_start"];
  // On the Mac, the "user config" is the one codexHome writes, which turns on the computer-use plugin.
  const base = ["codex", "exec", ...(MAC ? [] : ["--ignore-user-config"]), "--skip-git-repo-check", "--sandbox", "read-only", "-C", dir, "-m", model, "-c", `model_reasoning_effort="${effort}"`, "-c", `web_search="disabled"`];
  if (MAC) return [...base, ...off.flatMap((f) => ["--disable", f]), "--json", prompt];
  // Headless Codex refuses MCP calls that need approval, which is every input tool.
  // Codex hands MCP servers a scrubbed environment, so pass Puck what tells it
  // which private desktop is ours; without it Puck sees the live session.
  const keep = ["WARD_ID", "WARD_ROOT", "WARD_SHIMS", "T3CODE_THREAD_ID", "TMPDIR", "PATH", "XDG_RUNTIME_DIR"];
  const env = keep.flatMap((k) => (process.env[k] ? [`${k}=${JSON.stringify(process.env[k])}`] : [])).join(",");
  return [
    ...base,
    "-c", `mcp_servers.puck.command=${JSON.stringify(PUCK)}`, "-c", `mcp_servers.puck.args=["mcp"]`, "-c", `mcp_servers.puck.env={${env}}`, "-c", `mcp_servers.puck.default_tools_approval_mode="approve"`,
    ...["plugins", "computer_use", ...off].flatMap((f) => ["--disable", f]), "--json", prompt,
  ];
}

/**
 * Computer use asks the person, per app, before touching it; headless Codex
 * can't answer, so the ask is declined. Answering "allow for this session"
 * writes computer-use/sessions/<thread-id>.toml, so write that for the
 * benchmark's two apps as soon as Codex names the thread, which it does
 * before the model's first request.
 */
function allowAppsForThread(stdout: NodeJS.ReadableStream) {
  let file: string | undefined;
  createInterface({ input: stdout }).on("line", (line) => {
    const id = !file && line.match(/^\{"type":"thread\.started","thread_id":"([\w-]+)"/)?.[1];
    if (!id) return;
    file = join(CODEX_HOME, "computer-use", "sessions", `${id}.toml`);
    writeFileSync(file, `[apps]\nallowed = ["net.imput.helium", "md.obsidian"]\n`);
  });
  /** Removes the approval once the run is over. */
  return () => file && rmSync(file, { force: true });
}

function runAgent(prompt: string, dir: string, transcript: string): Promise<number> {
  const [cmd, ...argv] = agentCommand(prompt, dir);
  if (!cmd) throw new Error("empty agent command");
  const child = spawn(cmd, argv, { cwd: dir, env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(createWriteStream(transcript));
  const revoke = MAC && client === "codex" ? allowAppsForThread(child.stdout) : undefined;
  child.stderr.pipe(createWriteStream(`${transcript}.err`));
  const started = Date.now();
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("close", () => {
      clearTimeout(timer);
      revoke?.();
      resolve(Date.now() - started);
    });
  });
}

/**
 * Claude Code session transcripts created since `since` that hold `text`. Other
 * sessions on the machine may mention the benchmark too (an agent running it,
 * say), so only a session started after the run began, quoting the task's
 * prompt as JSON does, counts.
 */
function sessionsSince(since: number, text: string): string[] {
  const root = join(homedir(), ".claude", "projects");
  const quoted = JSON.stringify(text).slice(1, -1);
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((p) => p.endsWith(".jsonl"))
    .map((p) => join(root, p))
    .filter((p) => statSync(p).birthtimeMs >= since && readFileSync(p, "utf8").includes(quoted))
    .sort((a, b) => statSync(b).birthtimeMs - statSync(a).birthtimeMs);
}

/** The model a session's responses came from, so a wrong pick in the app isn't recorded as `model`. */
const sessionModel = (path: string) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as { type?: string; message?: { model?: string } })
    .find((l) => l.type === "assistant" && l.message?.model)?.message?.model;

/**
 * Claude desktop can't be driven from a script, so a person runs its side: the
 * prompt goes to the clipboard, they paste it into a new Code session on
 * `model` with computer use on, and press Enter here once the agent is done.
 */
async function assisted(prompt: string, task: Task, dir: string) {
  spawnSync("pbcopy", { input: prompt });
  const since = Date.now();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question(`\n[${task.id}] Prompt copied. In Claude desktop, start a new Code session on ${model}, paste it, and let it run.\nPress Enter here when it has finished. `);
  rl.close();
  const [session] = sessionsSince(since, task.prompt);
  if (!session) throw new Error(`no Claude session started since this run began quotes the ${task.id} prompt`);
  const used = sessionModel(session);
  if (!used?.startsWith(model)) throw new Error(`the session ran on ${used ?? "an unknown model"}, not ${model}; redo this task on ${model}`);
  cpSync(session, join(dir, "transcript.jsonl"));
  // ToolSearch only loads the computer-use tools' definitions; it can't touch the desktop.
  return claudeSessionUsage(session, (tool) => tool === "ToolSearch" || tool.startsWith("mcp__computer-use__"));
}

async function runOne(t: Task, rep: number): Promise<Row> {
  const started_at = new Date().toISOString();
  const run_id = `${started_at.replace(/[:.]/g, "-")}-${client}-${model}-${t.id}-${rep}`;
  const dir = join(RESULTS, "runs", run_id);
  mkdirSync(dir, { recursive: true });
  const vault = await prepare(dir);
  const transcript = join(dir, "transcript.jsonl");
  const prompt = `${PREAMBLE}\n\nTask: ${t.prompt}`;
  let measured: Usage & { wall_ms: number };
  if (client === "claude-desktop") {
    measured = await assisted(prompt, t, dir);
  } else {
    const wall_ms = await runAgent(prompt, dir, transcript);
    if (client === "codex") checkCodexHome();
    measured = {
      wall_ms,
      ...(client === "claude"
        ? claudeUsage(transcript, (tool) => tool.startsWith("mcp__puck__"))
        : codexUsage(transcript, (server) => server === (MAC ? "cua_repl" : "puck"), join(CODEX_HOME, "sessions"))),
    };
  }
  const shot = join(dir, "final.png");
  if (MAC) spawnSync("screencapture", ["-x", shot]);
  else spawnSync(PUCK, ["inspect", "--region", "0,0,1280x720", "--text", "none", "--screenshot", shot]);
  // Obsidian saves edits after a short debounce; let it land before judging.
  await sleep(2500);
  const { passed, detail } = t.check(vault);
  const { final_message: _, ...usage } = measured;
  const work_tokens = usage.context_tokens === null ? null : usage.input_tokens - usage.turns * usage.context_tokens;
  return {
    run_id, started_at, task: t.id, harness: MAC ? "computer-use" : "puck", platform: MAC ? "macos" : "linux",
    client: client === "claude" ? "claude-code" : client, model, effort, rep, passed, detail, work_tokens, ...usage,
  };
}

mkdirSync(RESULTS, { recursive: true });
const server = await serveSite();
try {
  for (let rep = firstRep; rep <= lastRep; rep++) {
    for (const t of tasks) {
      const row = await runOne(t, rep);
      appendFileSync(join(RESULTS, "runs.jsonl"), `${JSON.stringify(row)}\n`);
      console.log(`${row.task} rep ${rep}: ${row.passed ? "PASS" : "FAIL"} (${row.detail}) ${Math.round(row.wall_ms / 1000)}s, ${row.turns} turns, ${row.input_tokens} in / ${row.output_tokens} out${row.violations.length ? `, violations: ${row.violations.join(" ")}` : ""}`);
    }
  }
} finally {
  await killApps();
  server.close();
}
