import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Desktop } from "./exec.ts";

/**
 * Activity records: while the host's recorder is on, each MCP tool call leaves
 * one small JSON file in Ward's activity folder. The recorder switches itself on
 * by keeping a file `on` there fresh; Ward hides the folder from wards. Records
 * hold what the agent did, never what it typed or what was on screen.
 */

const FRESH_SECONDS = 30;
const TEXT_LIMIT = 300;
const ARRAY_LIMIT = 50;
const DEPTH_LIMIT = 8;

export function activityDir(): string {
  return process.env.PUCK_ACTIVITY_DIR ?? join(process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}`, "ward", "activity");
}

/** Whether the recorder is on: `on`'s first word is the epoch seconds it was last written, fresh for 30 s. Read on every call. */
export function recording(now = Date.now()): boolean {
  try {
    const stamp = readFileSync(join(activityDir(), "on"), "utf8").trim().split(/\s+/)[0] ?? "";
    if (!/^\d+$/.test(stamp)) return false;
    const age = now / 1000 - Number(stamp);
    return age <= FRESH_SECONDS && age >= -5;
  } catch {
    return false;
  }
}

/** Cut a long string, without its last word: half a token is no longer something a redactor recognises. */
const cut = (s: string) => (s.length > TEXT_LIMIT ? `${s.slice(0, TEXT_LIMIT).replace(/\S+$/, "")}…` : s);

/** A JSON-safe copy with long strings and arrays cut; whatever JSON can't hold is dropped. */
function clean(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return cut(value);
  if (depth >= DEPTH_LIMIT) return undefined;
  if (Array.isArray(value)) return value.slice(0, ARRAY_LIMIT).map((v) => clean(v, depth + 1) ?? null);
  if (typeof value !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const c = clean(v, depth + 1);
    if (c !== undefined) out[k] = c;
  }
  return out;
}

const TypeTextArgs = z.looseObject({ text: z.string() });
const PressKeysArgs = z.looseObject({ keys: z.array(z.string()) });

/** Keys that type nothing: safe to name. Anything else that is one "word" could be text. */
const NAMED_KEY = /^(?:enter|return|tab|escape|esc|backspace|delete|insert|home|end|page_?up|page_?down|prior|next|up|down|left|right|space|menu|print|pause|caps_lock|f\d{1,2})$/i;
const COMMAND_MODIFIER = /^(?:ctrl|control|alt|super|meta|logo|mod\d?|win|cmd)$/i;

/**
 * Whether a key says what was done rather than what was typed: a named key (`Enter`, `F5`) or
 * a chord with a command modifier (`ctrl+s`, `super+shift+q`). A character, with or without
 * shift, may be part of a password (`shift+h` gives away a capital), and so may any other word.
 */
const isNamedKey = (key: string) => {
  const parts = key.split("+");
  const last = parts.at(-1) ?? "";
  const mods = parts.slice(0, -1);
  if (!mods.length) return NAMED_KEY.test(key);
  // Every modifier a real one, at least one a command modifier, and the key itself one character or a named key.
  return mods.every((m) => COMMAND_MODIFIER.test(m) || /^shift$/i.test(m)) && mods.some((m) => COMMAND_MODIFIER.test(m)) && ([...last].length === 1 || NAMED_KEY.test(last));
};

/** Tools whose error messages can repeat what was typed (a failed `wtype` names its arguments). */
const TYPING_TOOLS = new Set(["type_text", "press_keys"]);

/** A tool's arguments for the record: typed text reduced to its length, single character keys to a count, long values cut. */
export function sanitizeArgs(tool: string, args: unknown): unknown {
  if (tool === "type_text") {
    const parsed = TypeTextArgs.safeParse(args);
    if (parsed.success) {
      const { text, ...rest } = parsed.data;
      return { ...(clean(rest) as object), text: { chars: [...text].length } };
    }
  }
  if (tool === "press_keys") {
    const parsed = PressKeysArgs.safeParse(args);
    if (parsed.success) {
      const { keys, ...rest } = parsed.data;
      const kept = keys.filter(isNamedKey);
      return { ...(clean(rest) as object), keys: kept.map(cut), typed: keys.length - kept.length };
    }
  }
  return clean(args);
}

const Block = z.object({ type: z.string() }).loose();
const ImageBlock = z.object({ type: z.literal("image"), data: z.string() });
const TextBlock = z.object({ type: z.literal("text"), text: z.string() });
const ToolResult = z.object({ content: z.array(Block).optional(), isError: z.boolean().optional() }).loose();
const Named = z.object({ app_id: z.string().optional(), title: z.string().optional() });
const Shot = z.object({ width: z.number(), height: z.number(), target: z.unknown() });

/** The text of a tool result's first text block, if it has one. */
function firstText(result: unknown): string | undefined {
  for (const block of ToolResult.safeParse(result).data?.content ?? []) {
    const text = TextBlock.safeParse(block);
    if (text.success) return text.data.text;
  }
  return undefined;
}

/** The first text block of a tool result, parsed as JSON; undefined when there isn't one. */
function resultJson(result: unknown): unknown {
  try {
    const text = firstText(result);
    return text === undefined ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Tools whose results are other people's text (notification titles), never a window. */
const NOT_WINDOWS = new Set(["notifications", "dismiss_notification"]);

/**
 * What a tool result was, without its content: each image's size and a short
 * hash (so repeated captures of an unchanged screen can be told apart from new
 * ones), a screenshot's dimensions and target, and the window a result names.
 */
export function summarizeResult(tool: string, result: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const content = ToolResult.safeParse(result).data?.content ?? [];
  const images = content.flatMap((b) => {
    const image = ImageBlock.safeParse(b);
    if (!image.success) return [];
    const bytes = Buffer.from(image.data.data, "base64");
    return [{ bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex").slice(0, 16) }];
  });
  if (images.length) out.images = images;

  const parsed = resultJson(result);
  if (tool === "screenshot") {
    const shot = Shot.safeParse(parsed);
    if (shot.success) Object.assign(out, { width: shot.data.width, height: shot.data.height, target: clean(shot.data.target) });
  }
  if (!NOT_WINDOWS.has(tool)) {
    const holder = z.object({ window: Named.nullable() }).safeParse(parsed);
    const named = holder.success ? holder.data.window : Named.safeParse(Array.isArray(parsed) ? parsed[0] : parsed).data;
    if (named && (named.app_id !== undefined || named.title !== undefined)) {
      out.window = { app_id: named.app_id === undefined ? null : cut(named.app_id), title: named.title === undefined ? null : cut(named.title) };
    }
  }
  return out;
}

/** The desktop a desktop_state result says it is on, the one tool that chooses for itself. */
export function reportedDesktop(result: unknown): Desktop | null {
  const parsed = z.object({ desktop: z.enum(["private", "live"]) }).safeParse(resultJson(result));
  return parsed.success ? parsed.data.desktop : null;
}

/** This process's cgroup path: where the host can tell which agent or thread it belongs to. */
const scope = (() => {
  try {
    const line = readFileSync("/proc/self/cgroup", "utf8")
      .split("\n")
      .find((l) => l.startsWith("0::"));
    return line ? line.slice(3) : null;
  } catch {
    return null;
  }
})();

let counter = 0;

export type ActivityEvent = {
  tool: string;
  args: unknown;
  /** Epoch milliseconds. */
  start: number;
  end: number;
  /** What the handler returned, or what it threw. */
  outcome: { result: unknown } | { thrown: unknown };
  desktop: Desktop | null;
};

/**
 * Leaves one record of a tool call for the recorder, when it is on. Never throws,
 * never creates the folder, and is synchronous: the tool's result is not held up
 * or changed by it.
 */
export function record(event: ActivityEvent): void {
  try {
    if (!recording()) return;
    const { outcome } = event;
    const failure = "thrown" in outcome ? (outcome.thrown instanceof Error ? outcome.thrown.message : String(outcome.thrown)) : undefined;
    const result = "result" in outcome ? outcome.result : undefined;
    const flagged = ToolResult.safeParse(result).data?.isError === true;
    const failed = failure !== undefined || flagged;
    const message = !failed ? undefined : TYPING_TOOLS.has(event.tool) ? "failed (the message may repeat what was typed, so it isn't recorded)" : (failure ?? firstText(result));
    const body = {
      v: 1,
      scope,
      thread: process.env.T3CODE_THREAD_ID ?? null,
      start: event.start,
      end: event.end,
      tool: event.tool,
      ok: failure === undefined && !flagged,
      error: message === undefined ? null : cut(message),
      desktop: event.desktop,
      args: sanitizeArgs(event.tool, event.args) ?? null,
      result: summarizeResult(event.tool, result),
    };
    const dir = activityDir();
    const id = `${process.pid}.${counter++}`;
    const tmp = join(dir, `.puck.${id}.tmp`);
    writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
    renameSync(tmp, join(dir, `puck.${id}.json`));
  } catch {
    // Recording must never touch the tool call.
  }
}
