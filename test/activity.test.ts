import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { record, recording, sanitizeArgs, summarizeResult } from "../src/activity.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "puck-activity-"));
  process.env.PUCK_ACTIVITY_DIR = dir;
});
afterEach(() => {
  delete process.env.PUCK_ACTIVITY_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const switchOn = (seconds = Date.now() / 1000) => writeFileSync(join(dir, "on"), `${Math.floor(seconds)} recorder\n`);
const records = () => readdirSync(dir).filter((f) => f.endsWith(".json"));

describe("recording", () => {
  it("is on for a fresh file, off for a stale, missing or garbage one", () => {
    const now = 1_000_000_000_000;
    expect(recording(now)).toBe(false);
    switchOn(now / 1000 - 5);
    expect(recording(now)).toBe(true);
    switchOn(now / 1000 - 31);
    expect(recording(now)).toBe(false);
    writeFileSync(join(dir, "on"), "yes\n");
    expect(recording(now)).toBe(false);
  });
});

describe("sanitizeArgs", () => {
  it("replaces typed text with its length", () => {
    expect(sanitizeArgs("type_text", { window_id: "w1", text: "hunter2" })).toEqual({ window_id: "w1", text: { chars: 7 } });
  });

  it("keeps chords and named keys, counts single characters", () => {
    expect(sanitizeArgs("press_keys", { window_id: "w1", keys: ["ctrl+a", "p", "a", "Enter", "s"] })).toEqual({
      window_id: "w1",
      keys: ["ctrl+a", "Enter"],
      typed: 3,
    });
    // A shifted character gives away a capital or a symbol, and a word may be the password itself.
    expect(sanitizeArgs("press_keys", { keys: ["shift+h", "shift+1", "hunter2", "super+shift+q", "F5"] })).toEqual({ keys: ["super+shift+q", "F5"], typed: 3 });
  });

  it("cuts long strings and arrays at any depth and drops what isn't JSON", () => {
    const out = sanitizeArgs("inspect", { deep: { s: "x".repeat(500), list: Array.from({ length: 80 }, (_, i) => i), f: () => 1, n: 10n } });
    expect(out).toEqual({ deep: { s: "x".repeat(300), list: Array.from({ length: 50 }, (_, i) => i) } });
  });
});

describe("summarizeResult", () => {
  it("describes a screenshot by size and hash, not pixels", () => {
    const pixels = Buffer.from("not really a jpeg");
    const result = {
      content: [
        { type: "image", data: pixels.toString("base64"), mimeType: "image/jpeg" },
        { type: "text", text: JSON.stringify({ width: 1568, height: 882, target: { kind: "output", name: "DP-2", width: 2560, height: 1440, scale: 1 } }) },
      ],
    };
    expect(summarizeResult("screenshot", result)).toEqual({
      images: [{ bytes: pixels.length, sha256: createHash("sha256").update(pixels).digest("hex").slice(0, 16) }],
      width: 1568,
      height: 882,
      target: { kind: "output", name: "DP-2", width: 2560, height: 1440, scale: 1 },
    });
  });

  it("names the window a result is about, and nothing else it says", () => {
    const launched = { content: [{ type: "text", text: JSON.stringify({ app: "Zed", window: { id: "7", app_id: "dev.zed.Zed", title: "main.ts", x: 0 } }) }] };
    expect(summarizeResult("launch_app", launched)).toEqual({ window: { app_id: "dev.zed.Zed", title: "main.ts" } });
    const page = { content: [{ type: "text", text: JSON.stringify({ text: "secret page text" }) }] };
    expect(summarizeResult("inspect", page)).toEqual({});
  });
});

describe("record", () => {
  const event = {
    tool: "type_text",
    args: { window_id: "w1", text: "hunter2" },
    start: 1000,
    end: 1250,
    outcome: { result: { content: [{ type: "text", text: "{}" }] } },
    desktop: "private",
  } as const;

  it("writes one owner-only file with the typed text removed when on", () => {
    switchOn();
    record(event);
    const [file, ...rest] = records();
    expect(rest).toEqual([]);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(statSync(join(dir, file ?? "")).mode & 0o777).toBe(0o600);
    const text = readFileSync(join(dir, file ?? ""), "utf8");
    expect(text).not.toContain("hunter2");
    expect(JSON.parse(text)).toMatchObject({
      v: 1,
      start: 1000,
      end: 1250,
      tool: "type_text",
      ok: true,
      error: null,
      desktop: "private",
      args: { window_id: "w1", text: { chars: 7 } },
      result: {},
    });
  });

  it("records a throw as not ok, with its message", () => {
    switchOn();
    record({ ...event, tool: "click", args: { window_id: "w1" }, outcome: { thrown: new Error("Refused on the live session") } });
    const [file] = records();
    expect(JSON.parse(readFileSync(join(dir, file ?? ""), "utf8"))).toMatchObject({ ok: false, error: "Refused on the live session" });
  });

  it("never records a typing tool's error message, which can repeat what was typed", () => {
    switchOn();
    record({ ...event, outcome: { thrown: new Error("Command failed: wtype -- hunter2") } });
    record({ ...event, tool: "press_keys", args: { keys: ["h"] }, outcome: { result: { isError: true, content: [{ type: "text", text: "Unknown key: hunter2" }] } } });
    const texts = records().map((f) => readFileSync(join(dir, f), "utf8"));
    expect(texts).toHaveLength(2);
    for (const text of texts) {
      expect(text).not.toContain("hunter2");
      expect(JSON.parse(text)).toMatchObject({ ok: false });
    }
  });

  it("writes nothing when off", () => {
    record(event);
    expect(records()).toEqual([]);
  });

  it("does not throw or create the folder when it is missing", () => {
    const missing = join(dir, "nope");
    process.env.PUCK_ACTIVITY_DIR = missing;
    expect(() => record(event)).not.toThrow();
    expect(() => statSync(missing)).toThrow();
    mkdirSync(missing);
    writeFileSync(join(missing, "on"), `${Math.floor(Date.now() / 1000)}\n`);
    process.env.PUCK_ACTIVITY_DIR = join(missing, "gone", "deeper");
    expect(() => record(event)).not.toThrow();
  });
});
