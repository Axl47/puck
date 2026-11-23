import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type CallToolResult, CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { onDesktop, sleep } from "../exec.ts";
import { inspect } from "../inspect.ts";
import { snapshot, windows } from "../umbriel.ts";

/**
 * `run`: several tool calls in one, with waits between them, so an agent that
 * would click, wait and screenshot over three model turns does it in one.
 * Each step goes through the tool exactly as a client call would (server.ts
 * hands over the wrapped handlers), so it picks its desktop, passes the same
 * checks and leaves its own activity record.
 */

/** Every tool as server.ts registered it: its input schema and the call a client would make. */
export type Tools = Map<string, { schema: unknown; call: (args: unknown, extra: unknown) => Promise<unknown> }>;

/** Tools a run can't take: desktop_state moves every later call to another desktop. */
const NOT_STEPS = new Set(["desktop_state", "run"]);

const WaitArgs = z
  .object({
    window: z
      .object({ app_id: z.string().min(1).optional(), title: z.string().min(1).optional() })
      .optional()
      .describe("Until a window is on the desktop whose app_id and title contain these (any case)"),
    text: z
      .string()
      .min(1)
      .optional()
      .describe("Until this text shows (any case): in window_id, else anywhere on the focused output. Read from the accessibility tree, else OCR"),
    window_id: z.string().optional().describe("Where to look for text"),
    ms: z.number().int().min(1).max(30_000).optional().describe("Just wait this long"),
    timeout_ms: z.number().int().min(100).max(30_000).default(10_000),
  })
  .strict()
  .refine((a) => [a.window, a.text, a.ms].filter((v) => v !== undefined).length === 1, "Pass exactly one of window, text, ms.")
  .refine((a) => !a.window || a.window.app_id !== undefined || a.window.title !== undefined, "window needs app_id or title.")
  .refine((a) => a.window_id === undefined || a.text !== undefined, "window_id goes with text.");
type WaitArgs = z.infer<typeof WaitArgs>;

const contains = (haystack: string, needle: string) => haystack.toLowerCase().replace(/\s+/g, " ").includes(needle.toLowerCase().replace(/\s+/g, " "));

const cancelled = (extra: unknown) => z.object({ signal: z.instanceof(AbortSignal) }).safeParse(extra).data?.signal.aborted === true;

/** Polls `check` until it gives a value, at least once, until the timeout; null when it never did. */
async function poll<T>(timeoutMs: number, extra: unknown, check: () => Promise<T | null>): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await check();
    if (found !== null) return found;
    if (Date.now() >= deadline) return null;
    if (cancelled(extra)) throw new Error("Cancelled.");
    await sleep(250);
  }
}

/** A wait step. Each check picks its desktop, as a tool call would: a launch earlier in the run may have just started the private one. */
async function wait(args: WaitArgs, extra: unknown): Promise<CallToolResult> {
  const start = Date.now();
  const done = (more: object = {}) => ({ content: [{ type: "text" as const, text: JSON.stringify({ waited_ms: Date.now() - start, ...more }) }] });
  const seconds = `${args.timeout_ms / 1000} s`;
  if (args.ms !== undefined) {
    await sleep(args.ms);
    return done();
  }
  if (args.window) {
    const { app_id, title } = args.window;
    const w = await poll(args.timeout_ms, extra, () =>
      onDesktop(async () => (await windows()).find((w) => (app_id === undefined || contains(w.app_id, app_id)) && (title === undefined || contains(w.title, title))) ?? null),
    );
    const wanted = [app_id && `app_id containing "${app_id}"`, title && `title containing "${title}"`].filter(Boolean).join(" and ");
    if (!w) throw new Error(`No window with ${wanted} within ${seconds}.`);
    return done({ window: { id: w.id, app_id: w.app_id, title: w.title } });
  }
  const text = args.text ?? "";
  let source = "";
  const seen = await poll(args.timeout_ms, extra, () =>
    onDesktop(async () => {
      const snap = await snapshot();
      const out = snap.outputs.find((o) => o.focused && o.enabled) ?? snap.outputs.find((o) => o.enabled);
      if (!args.window_id && !out) throw new Error("No outputs.");
      const target = args.window_id
        ? ({ kind: "window", id: args.window_id } as const)
        : ({ kind: "region", rect: { x: out!.position.x, y: out!.position.y, width: out!.logical_size.width, height: out!.logical_size.height } } as const);
      const found = await inspect(target, { text: "auto" });
      source = found.text.source;
      return contains(found.text.content, text) ? true : null;
    }),
  );
  if (!seen) throw new Error(`"${text}" didn't show in ${args.window_id ?? "the focused output"} within ${seconds} (read by ${source || "nothing"}).`);
  return done();
}

type Step = { tool: string; run: () => Promise<CallToolResult> };
type Block = CallToolResult["content"][number];

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Checks every step against its tool's schema, so a mistake in step 5 stops the run before step 1 acts. */
async function plan(steps: readonly { tool: string; args?: unknown }[], tools: Tools, extra: unknown): Promise<Step[]> {
  return Promise.all(
    steps.map(async ({ tool, args = {} }, i): Promise<Step> => {
      const where = `Step ${i + 1} (${tool})`;
      if (tool === "wait") {
        const parsed = await WaitArgs.safeParseAsync(args);
        if (!parsed.success) throw new Error(`${where}: ${z.prettifyError(parsed.error)}`);
        return { tool, run: () => wait(parsed.data, extra) };
      }
      const entry = tools.get(tool);
      if (!entry || NOT_STEPS.has(tool)) throw new Error(`${where}: not a tool a run can take.`);
      const { schema } = entry;
      let valid: unknown = args;
      if (schema instanceof z.core.$ZodType) {
        const parsed = await z.safeParseAsync(schema, args);
        if (!parsed.success) throw new Error(`${where}: ${z.prettifyError(parsed.error)}`);
        valid = parsed.data;
      }
      return { tool, run: async () => CallToolResultSchema.parse(await entry.call(valid, extra)) };
    }),
  );
}

/** One step's result for the run's: its text after a numbered label, then its images. */
function labelled(n: number, tool: string, result: CallToolResult): Block[] {
  const texts = result.content.flatMap((b) => (b.type === "text" ? [b.text] : []));
  return [{ type: "text", text: `${n}. ${tool}: ${texts.join("\n")}` }, ...result.content.filter((b) => b.type !== "text")];
}

/**
 * Runs the steps in order and stops at the first that fails. A failed run
 * returns the steps before it, the error, and a screenshot of the screen then.
 */
export async function runSteps(steps: readonly { tool: string; args?: unknown }[], tools: Tools, extra: unknown): Promise<CallToolResult> {
  const planned = await plan(steps, tools, extra).catch((err: unknown) => {
    throw new Error(`${message(err)}\nNo step ran.`);
  });
  const content: Block[] = [];
  for (const [i, step] of planned.entries()) {
    const failure = cancelled(extra)
      ? "Cancelled."
      : await step.run().then(
          (result) => {
            if (result.isError) return result.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n") || "failed";
            content.push(...labelled(i + 1, step.tool, result));
            return null;
          },
          (err: unknown) => message(err),
        );
    if (failure === null) continue;
    const rest = planned.length - i - 1;
    content.push({ type: "text", text: `${i + 1}. ${step.tool} failed: ${failure}${rest ? ` The ${rest} step(s) after it didn't run.` : ""}` });
    const screen = tools.get("screenshot");
    if (screen) {
      await screen.call({}, extra).then(
        (shot) => content.push({ type: "text", text: "The screen after it:" }, ...CallToolResultSchema.parse(shot).content.filter((b) => b.type !== "text")),
        (err: unknown) => content.push({ type: "text", text: `No screenshot: ${message(err)}` }),
      );
    }
    return { content, isError: true };
  }
  return { content };
}

export function registerRun(server: McpServer, tools: Tools): void {
  const names = [...tools.keys()].filter((name) => !NOT_STEPS.has(name));
  server.registerTool(
    "run",
    {
      title: "Run steps",
      description:
        "Make several Puck tool calls in order in one call, with waits between them, and get every result back, e.g. click a button, wait for the dialog, screenshot it. " +
        "A step is { tool, args } with the args that tool takes, or { tool: \"wait\", args } to wait for a window, for text to show, or for ms. " +
        "Every step is checked before any runs. The run stops at the first step that fails or wait that times out and returns the steps before it, the error, and a screenshot of the focused output. End with a screenshot step to see the result.",
      inputSchema: {
        steps: z
          .array(
            z.union([
              z.object({ tool: z.literal("wait"), args: WaitArgs }),
              z.object({ tool: z.enum(names), args: z.record(z.string(), z.unknown()).default({}) }),
            ]),
          )
          .min(1)
          .max(25),
      },
      annotations: { destructiveHint: true },
    },
    async ({ steps }, extra) => runSteps(steps, tools, extra),
  );
}
