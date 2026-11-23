import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * What one transcript says about a run. Token fields mean the same thing for
 * every client: `input_tokens` is every prompt token the model read (cached or
 * not), `cache_read_tokens` the part served from cache.
 */
export type Usage = {
  turns: number;
  tool_calls: number;
  failed_actions: number;
  /** Images handed back to the model by tools (screenshots, mostly). */
  screenshots: number;
  input_tokens: number;
  /**
   * Prompt tokens of the first model request: the system prompt, tool
   * definitions and task, which every later request carries again. The rest of
   * `input_tokens` is what the work itself added (screenshots, tool results).
   */
  context_tokens: number | null;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  /** Tools used that the benchmark bans: anything but driving the desktop. */
  violations: string[];
  final_message: string;
};

type Block = { type?: string; name?: string; is_error?: boolean; content?: unknown; text?: string };
type ClaudeUsage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
type ClaudeEvent = {
  type?: string;
  message?: { id?: string; content?: Block[] | string; usage?: ClaudeUsage };
  result?: string;
  usage?: ClaudeUsage;
};
type CodexItem = { type?: string; server?: string; tool?: string; status?: string; error?: unknown; text?: string; result?: { content?: Block[]; isError?: boolean } | null };
type CodexEvent = { type?: string; thread_id?: string; item?: CodexItem; usage?: { input_tokens?: number; cached_input_tokens?: number; cache_write_input_tokens?: number; output_tokens?: number } };

const lines = <T>(path: string): T[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as T);

const prompt = (u: ClaudeUsage) => (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);

const images = (content: unknown) => (Array.isArray(content) ? content.filter((c: Block) => c.type === "image").length : 0);

/** Reads `claude -p --output-format stream-json --verbose` output. */
export function claudeUsage(path: string, allowed: (tool: string) => boolean): Usage {
  const usage: Usage = { turns: 0, tool_calls: 0, failed_actions: 0, screenshots: 0, input_tokens: 0, context_tokens: null, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, violations: [], final_message: "" };
  const requests = new Set<string>();
  for (const event of lines<ClaudeEvent>(path)) {
    // One model request can span several assistant events; they share its id.
    const id = event.message?.id;
    if (event.type === "assistant" && id && event.message?.usage && !requests.has(id)) {
      requests.add(id);
      usage.turns++;
      usage.context_tokens ??= prompt(event.message.usage);
    }
    const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
    for (const block of blocks) {
      if (event.type === "assistant" && block.type === "tool_use" && block.name) {
        usage.tool_calls++;
        if (!allowed(block.name)) usage.violations.push(block.name);
      }
      if (event.type === "user" && block.type === "tool_result") {
        if (block.is_error) usage.failed_actions++;
        usage.screenshots += images(block.content);
      }
    }
    if (event.type === "result") {
      const u = event.usage ?? {};
      usage.cache_read_tokens = u.cache_read_input_tokens ?? 0;
      usage.cache_write_tokens = u.cache_creation_input_tokens ?? 0;
      usage.input_tokens = (u.input_tokens ?? 0) + usage.cache_read_tokens + usage.cache_write_tokens;
      usage.output_tokens = u.output_tokens ?? 0;
      usage.final_message = event.result ?? "";
    }
  }
  return usage;
}

type SessionLine = {
  type?: string;
  timestamp?: string;
  message?: { id?: string; content?: Block[] | string; usage?: ClaudeUsage };
};

/**
 * Reads a Claude Code session transcript (`~/.claude/projects/…/<session>.jsonl`),
 * which is what a Claude desktop Code session leaves. A response split over
 * several lines repeats its usage on each, so usage counts once per message id.
 * Also returns the time from the first line to the last.
 */
export function claudeSessionUsage(path: string, allowed: (tool: string) => boolean): Usage & { wall_ms: number } {
  const usage: Usage = { turns: 0, tool_calls: 0, failed_actions: 0, screenshots: 0, input_tokens: 0, context_tokens: null, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, violations: [], final_message: "" };
  const counted = new Set<string>();
  const times: number[] = [];
  for (const line of lines<SessionLine>(path)) {
    if (line.timestamp && (line.type === "user" || line.type === "assistant")) times.push(Date.parse(line.timestamp));
    const blocks = Array.isArray(line.message?.content) ? line.message.content : [];
    for (const block of blocks) {
      if (line.type === "assistant" && block.type === "tool_use" && block.name) {
        usage.tool_calls++;
        if (!allowed(block.name)) usage.violations.push(block.name);
      }
      if (line.type === "assistant" && block.type === "text" && block.text) usage.final_message = block.text;
      if (line.type === "user" && block.type === "tool_result") {
        if (block.is_error) usage.failed_actions++;
        usage.screenshots += images(block.content);
      }
    }
    const id = line.message?.id;
    const u = line.message?.usage;
    if (line.type === "assistant" && id && u && !counted.has(id)) {
      counted.add(id);
      usage.turns++;
      if (!usage.context_tokens) usage.context_tokens = prompt(u);
      usage.cache_read_tokens += u.cache_read_input_tokens ?? 0;
      usage.cache_write_tokens += u.cache_creation_input_tokens ?? 0;
      usage.input_tokens += prompt(u);
      usage.output_tokens += u.output_tokens ?? 0;
    }
  }
  return { ...usage, wall_ms: times.length ? Math.max(...times) - Math.min(...times) : 0 };
}

type TokenCount = { payload?: { type?: string; info?: { last_token_usage?: { input_tokens?: number } } | null } };

/**
 * Prompt tokens of each model request in a Codex rollout (one `token_count`
 * event each), found under `sessions` by thread id. Rollouts are
 * zstd-compressed on some installs.
 */
export function codexRequests(sessions: string, thread: string): number[] | undefined {
  const found = spawnSync("find", [sessions, "-name", `*${thread}*`], { encoding: "utf8" }).stdout.trim().split("\n")[0];
  if (!found) return undefined;
  const text = found.endsWith(".zst") ? spawnSync("zstd", ["-dc", found], { encoding: "utf8", maxBuffer: 1 << 30 }).stdout : readFileSync(found, "utf8");
  return text
    .split("\n")
    .filter((l) => l.includes('"token_count"') && l.includes('"last_token_usage"'))
    .map((l) => (JSON.parse(l) as TokenCount).payload?.info?.last_token_usage?.input_tokens ?? 0);
}

/**
 * Reads `codex exec --json` output. The stream reports usage per task, not per
 * model request, so `turns` comes from the rollout in `sessions`; without one,
 * it falls back to tool calls plus the final answer.
 */
export function codexUsage(path: string, allowedServer: (server: string) => boolean, sessions?: string): Usage {
  let thread: string | undefined;
  const usage: Usage = { turns: 0, tool_calls: 0, failed_actions: 0, screenshots: 0, input_tokens: 0, context_tokens: null, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, violations: [], final_message: "" };
  for (const event of lines<CodexEvent>(path)) {
    if (event.type === "thread.started") thread = event.thread_id;
    const item = event.item;
    if (event.type === "item.completed" && item) {
      if (item.type === "mcp_tool_call") {
        usage.tool_calls++;
        if (!allowedServer(item.server ?? "")) usage.violations.push(`${item.server}.${item.tool}`);
        if (item.status === "failed" || item.error || item.result?.isError) usage.failed_actions++;
        usage.screenshots += images(item.result?.content);
      } else if (item.type === "agent_message") {
        usage.final_message = item.text ?? "";
      } else if (item.type && item.type !== "reasoning") {
        // command_execution, file_change, web_search and the like.
        usage.tool_calls++;
        usage.violations.push(item.type);
      }
    }
    if (event.type === "turn.completed" && event.usage) {
      usage.input_tokens += event.usage.input_tokens ?? 0;
      usage.cache_read_tokens += event.usage.cached_input_tokens ?? 0;
      usage.cache_write_tokens += event.usage.cache_write_input_tokens ?? 0;
      usage.output_tokens += event.usage.output_tokens ?? 0;
    }
  }
  const requests = sessions && thread ? codexRequests(sessions, thread) : undefined;
  usage.turns = requests?.length ?? usage.tool_calls + 1;
  usage.context_tokens = requests?.[0] ?? null;
  return usage;
}
