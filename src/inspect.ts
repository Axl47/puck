import { mkdtempSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { type CaptureTarget, captureToFile } from "./capture.ts";
import { run } from "./exec.ts";
import {
  type Point,
  type Rect,
  helperPath,
  outputAt,
  outputRect,
  pointerPosition,
  windowAt,
  windowRect,
} from "./pointer.ts";
import { type Window, findWindow, snapshot } from "./umbriel.ts";

// `inspect`: what is at a region, window or point: the window and its process,
// the accessible element, the text (accessibility or OCR), a screenshot.
// Miranda reads this JSON (its docs/DESIGN.md, "What Miranda needs from Puck").

export type InspectTarget =
  | { kind: "region"; rect: Rect }
  | { kind: "window"; id: string }
  | { kind: "point"; point: Point }
  | { kind: "pointer" };

export const TEXT_MODES = ["auto", "accessibility", "ocr", "none"] as const;
export type TextMode = (typeof TEXT_MODES)[number];

/** Parses `X,Y,WxH` (global logical pixels). */
export function parseRegion(s: string): Rect {
  const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(s.trim());
  if (!m) throw new Error(`Region "${s}" isn't X,Y,WxH.`);
  const [x, y, width, height] = m.slice(1).map(Number) as [number, number, number, number];
  if (width <= 0 || height <= 0) throw new Error(`Region "${s}" is empty.`);
  return { x, y, width, height };
}

/** Parses `X,Y` (global logical pixels). */
export function parsePoint(s: string): Point {
  const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(s.trim());
  if (!m) throw new Error(`Point "${s}" isn't X,Y.`);
  return { x: Number(m[1]), y: Number(m[2]) };
}

/** Linux reports process start in clock ticks since boot; USER_HZ is 100 on every architecture Puck runs on. */
const USER_HZ = 100;

/** A process's start time from its /proc/<pid>/stat line and the boot time (`btime`, seconds) from /proc/stat. */
export function processStartedAt(statLine: string, bootTime: number): Date {
  // Fields after the command name, which is parenthesized and may hold spaces or parens itself.
  const fields = statLine.slice(statLine.lastIndexOf(")") + 2).split(" ");
  const ticks = Number(fields[19]); // field 22 overall
  if (!Number.isFinite(ticks)) throw new Error("Unreadable /proc stat line.");
  return new Date((bootTime + ticks / USER_HZ) * 1000);
}

function processInfo(pid: number) {
  try {
    const btime = Number(/^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1]);
    const started = processStartedAt(readFileSync(`/proc/${pid}/stat`, "utf8"), btime);
    let exe: string | null = null;
    try {
      exe = readlinkSync(`/proc/${pid}/exe`);
    } catch {} // another user's process, or a zombie
    return { exe, process_started_at: started.toISOString() };
  } catch {
    return { exe: null, process_started_at: null }; // the process is gone
  }
}

const AccessibilitySchema = z.object({
  found: z.boolean(),
  url: z.string().nullable(),
  element: z
    .object({
      role: z.string(),
      name: z.string(),
      text: z.string(),
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    })
    .nullable(),
  text: z.string().nullable(),
  truncated: z.boolean().optional(),
  /** Some text node crossed the region's edge and couldn't be clipped to it. */
  partial: z.boolean().optional(),
});
type Accessibility = z.infer<typeof AccessibilitySchema>;

/** `clip`: keep only the text inside `rect` (a region), rather than all text of the nodes it touches. */
async function readAccessibility(w: Window, point: Point | null, rect: Rect | null, clip: boolean): Promise<Accessibility> {
  const request = { pid: w.pid, title: w.title, window: windowRect(w), point, rect, text: rect !== null, clip };
  return AccessibilitySchema.parse(JSON.parse(await run("python3", [helperPath("a11y.py"), JSON.stringify(request)])));
}

async function ocr(image: string): Promise<string> {
  const text = await run("tesseract", [image, "stdout", "-l", "eng"], { timeoutMs: 30_000 });
  return text.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** Whether `inner` lies within `outer`, give or take a border. */
const within = (inner: Rect, outer: Rect, slack = 2) =>
  inner.x >= outer.x - slack &&
  inner.y >= outer.y - slack &&
  inner.x + inner.width <= outer.x + outer.width + slack &&
  inner.y + inner.height <= outer.y + outer.height + slack;

/**
 * Which text source to use: accessibility when the window under the target
 * exposes non-blank text for it and the target lies within that window (it can't
 * see neighbouring windows), OCR otherwise. Forced modes are taken as given.
 */
export function chooseTextSource(mode: TextMode, a11yText: string | null, targetInWindow: boolean): "accessibility" | "ocr" | "none" {
  if (mode !== "auto") return mode;
  return targetInWindow && a11yText?.trim() ? "accessibility" : "ocr";
}

/** `screenshot`: a path to save the target's PNG at, or true for a new file in Puck's screenshot dir. */
export type InspectOptions = { text: TextMode; screenshot?: string | true | undefined };

export async function inspect(target: InspectTarget, opts: InspectOptions) {
  const snap = await snapshot();
  const errors: string[] = [];
  const pointer = await pointerPosition(snap.outputs).catch((err: unknown) => {
    errors.push(`pointer: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  });

  // The rectangle inspected, the window it's about, and the point whose element to report.
  let rect: Rect;
  let win: Window | null;
  let point: Point | null;
  switch (target.kind) {
    case "region":
      rect = target.rect;
      point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      win = windowAt(snap, point);
      break;
    case "window":
      win = findWindow(snap, target.id);
      rect = windowRect(win);
      point = null;
      break;
    case "point":
    case "pointer": {
      const p = target.kind === "point" ? target.point : pointer;
      if (!p) throw new Error(`Couldn't read the pointer position (${errors.join("; ")}).`);
      point = { x: p.x, y: p.y };
      win = windowAt(snap, point);
      const out = outputAt(snap.outputs, point);
      if (!win && !out) throw new Error(`${p.x},${p.y} is on no output.`);
      // A point is inspected through what holds it: its window, or the bare output.
      rect = win ? windowRect(win) : outputRect(out!);
      break;
    }
  }
  const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  const output =
    (win && snap.outputs.find((o) => o.name === win.output)) ?? outputAt(snap.outputs, center) ?? outputAt(snap.outputs, rect);
  if (!output) throw new Error("The target is on no output.");

  const wantA11yText = opts.text === "auto" || opts.text === "accessibility";
  let a11y: Accessibility | null = null;
  if (win) {
    try {
      a11y = await readAccessibility(win, point, wantA11yText ? rect : null, target.kind === "region");
      if (!a11y.found) errors.push(`accessibility: ${win.app_id} isn't on the accessibility bus`);
      if (a11y.truncated) errors.push("accessibility: tree too large; text and element may be incomplete");
      if (a11y.partial) errors.push("accessibility: text crossing the region's edge couldn't be cut to it and is included whole");
    } catch (err) {
      errors.push(`accessibility: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const capture: CaptureTarget =
    target.kind === "region" || !win
      ? { kind: "region", ...rect, scale: output.scale }
      : { kind: "window", id: win.id, width: win.w, height: win.h, scale: output.scale };
  const source = chooseTextSource(
    opts.text,
    a11y?.partial ? null : (a11y?.text ?? null), // text it couldn't clip to the region: OCR reads what's inside
    win !== null && within(rect, windowRect(win)),
  );
  const failed = (what: string) => (err: unknown) => {
    errors.push(`${what}: ${err instanceof Error ? err.message : String(err)}`);
  };
  let screenshot: string | null = null;
  let content = source === "accessibility" ? (a11y?.text ?? "") : "";
  if (opts.screenshot) {
    const path = opts.screenshot === true ? undefined : opts.screenshot;
    screenshot = (await captureToFile(capture, path).catch(failed("screenshot"))) ?? null;
  }
  if (source === "ocr") {
    if (screenshot) {
      content = (await ocr(screenshot).catch(failed("ocr"))) ?? "";
    } else {
      const ocrTemp = async () => {
        const dir = mkdtempSync(join(tmpdir(), "puck-inspect-"));
        try {
          return await ocr(await captureToFile(capture, join(dir, "target.png")));
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      };
      content = (await ocrTemp().catch(failed("ocr"))) ?? "";
    }
  }

  const focusedId = snap.focused?.id;
  return {
    pointer: pointer && { x: pointer.x, y: pointer.y },
    target: rect,
    output: { name: output.name, scale: Math.round(output.scale * 100) / 100 },
    window: win && {
      id: win.id,
      app_id: win.app_id,
      title: win.title,
      pid: win.pid,
      ...processInfo(win.pid),
      ...windowRect(win),
      workspace: win.workspace,
      output: win.output,
      floating: win.floating,
      fullscreen: win.fullscreen,
      focused: win.id === focusedId,
      url: a11y?.url ?? null,
    },
    element: a11y?.element ?? null,
    text: { source: source === "accessibility" && !a11y?.found ? "none" : source, content },
    screenshot,
    ...(errors.length ? { errors } : {}),
  };
}
export type Inspection = Awaited<ReturnType<typeof inspect>>;

