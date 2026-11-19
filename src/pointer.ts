import { fileURLToPath } from "node:url";
import { z } from "zod";
import { run } from "./exec.ts";
import { assertOutputs } from "./scope.ts";
import { type Output, type Window, keyboardGrab, outputs, withDesktopLock, withFocus } from "./umbriel.ts";

// Pointer reading and input. Umbriel's IPC has neither, so both go through
// helpers/wl.py, a small Wayland client (see its docstring).

export type Point = { x: number; y: number };
export type Rect = Point & { width: number; height: number };
export const BUTTONS = ["left", "right", "middle"] as const;
export type Button = (typeof BUTTONS)[number];

/** Path of a helper script; resolves the same from src/ (tests) and dist/ (installed). */
export const helperPath = (name: string) => fileURLToPath(new URL(`../helpers/${name}`, import.meta.url));

export const contains = (r: Rect, p: Point) => p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;

export const outputRect = (o: Output): Rect => ({ x: o.position.x, y: o.position.y, ...o.logical_size });
export const windowRect = (w: Window): Rect => ({ x: w.x, y: w.y, width: w.w, height: w.h });

/** The enabled output a point is on, if any. */
export const outputAt = (outs: readonly Output[], p: Point) => outs.find((o) => o.enabled && contains(outputRect(o), p)) ?? null;

/**
 * The topmost window under a point: visible on the output there (a scrolled-away
 * column keeps `visible` but sits outside its output), fullscreen over floating
 * over tiled, focused first among equals.
 */
export function windowAt(snap: { windows: readonly Window[]; outputs: readonly Output[]; focused: Window | null }, p: Point) {
  const out = outputAt(snap.outputs, p);
  if (!out) return null;
  const rank = (w: Window) => (w.fullscreen ? 4 : 0) + (w.floating ? 2 : 0) + (w.id === snap.focused?.id ? 1 : 0);
  const under = snap.windows.filter((w) => w.visible && !w.minimized && w.output === out.name && contains(windowRect(w), p));
  return under.sort((a, b) => rank(b) - rank(a))[0] ?? null;
}

/** The bounding box of every enabled output, which Umbriel maps virtual-pointer absolute motion over. */
export function layoutBounds(outs: readonly Output[]): Rect {
  const rects = outs.filter((o) => o.enabled).map(outputRect);
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return {
    x,
    y,
    width: Math.max(...rects.map((r) => r.x + r.width)) - x,
    height: Math.max(...rects.map((r) => r.y + r.height)) - y,
  };
}

export type PointerOp =
  | { op: "move"; x: number; y: number; width: number; height: number }
  | { op: "button"; button: Button; state: "press" | "release" }
  | { op: "scroll"; dx: number; dy: number }
  | { op: "sleep"; ms: number };

/** The helper's move op for a global point; throws when the point is on no output. */
export function moveOp(outs: readonly Output[], p: Point): PointerOp {
  if (!outputAt(outs, p)) throw new Error(`${p.x},${p.y} is on no output. Call desktop_state for output geometry.`);
  const b = layoutBounds(outs);
  // Floor keeps the pixel on the output holding the point (rounding up at its edge would cross to the next).
  return { op: "move", x: Math.floor(p.x - b.x), y: Math.floor(p.y - b.y), width: b.width, height: b.height };
}

/** Motion for a drag: press at `from`, glide in steps (apps ignore a single jump), release at `to`. */
export function dragOps(outs: readonly Output[], from: Point, to: Point, button: Button, steps = 12): PointerOp[] {
  const glide = Array.from({ length: steps }, (_, i) => {
    const t = (i + 1) / steps;
    return [moveOp(outs, { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }), { op: "sleep", ms: 15 } as const];
  }).flat();
  return [
    { op: "button", button, state: "press" },
    { op: "sleep", ms: 50 },
    ...glide,
    { op: "sleep", ms: 50 },
    { op: "button", button, state: "release" },
  ];
}

export function clickOps(button: Button, count: number): PointerOp[] {
  return Array.from({ length: count }, (_, i) => [
    ...(i > 0 ? [{ op: "sleep", ms: 60 } as const] : []),
    { op: "button", button, state: "press" } as const,
    { op: "button", button, state: "release" } as const,
  ]).flat();
}

const ProbeSchema = z.object({ output: z.string(), x: z.number(), y: z.number() });

/** Probes the pointer position. The probe's overlay would take a click, so callers hold the desktop lock. */
async function probePointer(outs: readonly Output[]): Promise<Point & { output: string }> {
  const p = ProbeSchema.parse(JSON.parse(await run("python3", [helperPath("wl.py"), "position"])));
  const o = outs.find((o) => o.name === p.output);
  if (!o) throw new Error(`The pointer is on ${p.output}, which Umbriel doesn't list.`);
  // Floor: the pixel the pointer is in; rounding up at an output's right edge would land on the next one.
  return { output: o.name, x: Math.floor(o.position.x + p.x), y: Math.floor(o.position.y + p.y) };
}

/** Where the pointer is, in global logical coordinates. Briefly maps an invisible overlay to ask the compositor. */
export async function pointerPosition(outs?: readonly Output[]): Promise<Point & { output: string }> {
  return withDesktopLock(async () => probePointer(outs ?? (await outputs())));
}

export async function pointerAct(ops: readonly PointerOp[]): Promise<void> {
  await run("python3", [helperPath("wl.py"), "act", JSON.stringify(ops)], { timeoutMs: 30_000 });
}

/** Throws unless every point is on an output PUCK_OUTPUTS allows. */
function assertPoints(outs: readonly Output[], points: readonly Point[]) {
  assertOutputs(
    ...points.map((p) => {
      const o = outputAt(outs, p);
      if (!o) throw new Error(`${p.x},${p.y} is on no output.`);
      return o.name;
    }),
  );
}

/** Moves the pointer to a point and leaves it there (focus follows it if the user's config says so). */
export async function movePointer(p: Point): Promise<Point> {
  return withDesktopLock(async () => {
    const outs = await outputs();
    assertPoints(outs, [p]);
    await pointerAct([moveOp(outs, p)]);
    return p;
  });
}

/**
 * Runs pointer input at `at` (the current position when null), then puts the
 * user's focus and the pointer back. Holds the desktop lock with
 * focus-follows-mouse paused, refuses while a shell panel is open (it would take
 * the input), and checks the pointer landed before pressing anything, so a user
 * moving the mouse stops it. `also` lists other points the input reaches (a
 * drag's end), which PUCK_OUTPUTS must allow too.
 */
export async function pointerInput(at: Point | null, ops: readonly PointerOp[], also: readonly Point[] = []) {
  // Refusals come before withFocus, whose cleanup would warp the cursor to the user's window.
  const outs = await outputs();
  assertPoints(outs, [...(at ? [at] : []), ...also]);
  const grab = await keyboardGrab();
  if (grab) throw new Error(`A shell panel (${grab.namespace}) is open and would take the input; nothing was sent.`);

  let home: Point | undefined;
  return withFocus(
    async (focus) => {
      const start = await probePointer(outs);
      const target = at ? { x: Math.floor(at.x), y: Math.floor(at.y) } : start;
      if (!at) assertPoints(outs, [start]);
      home = start;
      await pointerAct([moveOp(outs, target)]);
      const landed = await probePointer(outs);
      if (landed.x !== target.x || landed.y !== target.y) {
        home = undefined; // leave the mouse to the user
        throw new Error(
          `The pointer ended at ${landed.x},${landed.y}, not ${target.x},${target.y}; the user may be using the mouse. Nothing was pressed.`,
        );
      }
      await pointerAct(ops);
      await focus.settle(); // a click focuses what it hit; withFocus then hands focus back
      return { at: target };
    },
    {
      restoreFocus: true,
      // Focus restore warps the cursor onto the user's window; put it back where it was.
      cleanup: async () => {
        if (home) await pointerAct([moveOp(outs, home)]);
      },
    },
  );
}
