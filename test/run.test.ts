import { describe, expect, it } from "vitest";
import { z } from "zod";
import { sanitizeArgs } from "../src/activity.ts";
import { type Tools, runSteps } from "../src/tools/run.ts";

const text = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const shot = { content: [{ type: "image", data: "aGk=", mimeType: "image/jpeg" }, { type: "text", text: "{}" }] };

/** A click that records its args and fails at x = 13, and a screenshot. */
function fakeTools() {
  const calls: unknown[] = [];
  const tools: Tools = new Map([
    [
      "click",
      {
        schema: z.object({ x: z.number(), button: z.enum(["left", "right"]).default("left") }),
        call: async (args: unknown) => {
          calls.push(args);
          if (z.object({ x: z.literal(13) }).safeParse(args).success) throw new Error("refused");
          return text({ clicked: args });
        },
      },
    ],
    ["screenshot", { schema: z.object({}), call: async () => shot }],
  ]);
  return { tools, calls };
}

describe("runSteps", () => {
  it("checks every step before any runs", async () => {
    const { tools, calls } = fakeTools();
    const steps = [
      { tool: "click", args: { x: 1 } },
      { tool: "click", args: { x: "far" } },
    ];
    await expect(runSteps(steps, tools, {})).rejects.toThrow(/Step 2 \(click\).*No step ran/s);
    await expect(runSteps([{ tool: "wait", args: { ms: 5, text: "x" } }], tools, {})).rejects.toThrow(/exactly one/);
    await expect(runSteps([{ tool: "desktop_state" }], tools, {})).rejects.toThrow(/not a tool a run can take/);
    expect(calls).toEqual([]);
  });

  it("runs steps in order with their schema's defaults and labels each result", async () => {
    const { tools, calls } = fakeTools();
    const result = await runSteps([{ tool: "click", args: { x: 1 } }, { tool: "wait", args: { ms: 1 } }, { tool: "screenshot" }], tools, {});
    expect(calls).toEqual([{ x: 1, button: "left" }]);
    expect(result.isError).toBeUndefined();
    expect(result.content.map((b) => b.type)).toEqual(["text", "text", "text", "image"]);
    expect(result.content[0]).toEqual({ type: "text", text: '1. click: {"clicked":{"x":1,"button":"left"}}' });
    expect(result.content[2]).toEqual({ type: "text", text: "3. screenshot: {}" });
  });

  it("stops at the first failure and shows the screen then", async () => {
    const { tools, calls } = fakeTools();
    const steps = [1, 13, 2].map((x) => ({ tool: "click", args: { x } }));
    const result = await runSteps(steps, tools, {});
    expect(calls).toHaveLength(2);
    expect(result.isError).toBe(true);
    expect(result.content.map((b) => (b.type === "text" ? b.text : b.type))).toEqual([
      '1. click: {"clicked":{"x":1,"button":"left"}}',
      "2. click failed: refused The 1 step(s) after it didn't run.",
      "The screen after it:",
      "image",
    ]);
  });
});

describe("sanitizeArgs for run", () => {
  it("sanitizes each step as its own tool", () => {
    const args = { steps: [{ tool: "type_text", args: { window_id: "w1", text: "hunter2" } }, { tool: "press_keys", args: { keys: ["h", "Return"] } }] };
    expect(sanitizeArgs("run", args)).toEqual({
      steps: [
        { tool: "type_text", args: { window_id: "w1", text: { chars: 7 } } },
        { tool: "press_keys", args: { keys: ["Return"], typed: 1 } },
      ],
    });
    expect(sanitizeArgs("run", { steps: "hunter2" })).toBeNull();
  });
});
