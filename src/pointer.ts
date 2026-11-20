import { fileURLToPath } from "node:url";
import { z } from "zod";
import { run, sleep } from "./exec.ts";
import { assertOutputs } from "./scope.ts";
import { type Layer, type Output, type Snapshot, type Window, findWindow, layers, outputs, snapshot, withDesktopLock, withFocus } from "./umbriel.ts";

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

/** The overlap of two rectangles, or null when they don't meet. */
export function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x;
  const height = Math.min(a.y + a.height, b.y + b.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

/**
 * The part of a window actually on screen: its rectangle clipped to its own
 * output, or null when it's hidden or minimized or lies off the output (a
 * scrolled-away column, for which Umbriel's `visible` stays true).
 */
export function onScreen(w: Window, outs: readonly Output[]): Rect | null {
  const out = outs.find((o) => o.enabled && o.name === w.output);
  return out && w.visible && !w.minimized ? intersect(windowRect(w), outputRect(out)) : null;
}

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

/**
 * Points counted from a window's top-left corner, as in a screenshot of it, as
 * global ones. Throws for a point that isn't showing there (off the window,
 * scrolled away, covered, another workspace), which input would send to
 * something else.
 */
export function windowPoints(snap: Pick<Snapshot, "windows" | "outputs" | "focused">, windowId: string, points: readonly Point[]): Point[] {
  const w = findWindow(snap, windowId);
  return points.map((p) => {
    const at = { x: w.x + p.x, y: w.y + p.y };
    if (!contains({ x: 0, y: 0, width: w.w, height: w.h }, p)) throw new Error(`${p.x},${p.y} is outside window ${windowId}, which is ${w.w}×${w.h}.`);
    if (windowAt(snap, at)?.id !== w.id) throw new Error(`${p.x},${p.y} of window ${windowId} isn't showing (hidden, scrolled away or covered); focus the window first (focus_window, or puck focus ID in a shell).`);
    return at;
  });
}

/**
 * windowPoints on the desktop as it is now, with a check (`still`) for pointer
 * input to run once it holds the desktop lock: another call may have moved the
 * window while this one waited. Without a window the points are global already.
 */
export async function fromWindow<const P extends readonly Point[]>(windowId: string | undefined, points: P) {
  type Mapped = { -readonly [K in keyof P]: Point };
  if (windowId === undefined) return { points: [...points] as Mapped, still: undefined };
  const resolve = async () => windowPoints(await snapshot(), windowId, points);
  const at = await resolve();
  const still = async () => {
    const now = await resolve();
    if (now.some((p, i) => p.x !== at[i]?.x || p.y !== at[i]?.y)) throw new Error(`Window ${windowId} moved while the input waited; nothing was sent.`);
  };
  return { points: at as Mapped, still };
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
  const names = points.map((p) => {
    const o = outputAt(outs, p);
    if (!o) throw new Error(`${p.x},${p.y} is on no output.`);
    return o.name;
  });
  assertOutputs(...new Set(names));
}

/** Moves the pointer to a point and leaves it there (focus follows it if the user's config says so). `still`: fromWindow's check. */
export async function movePointer(p: Point, still?: () => Promise<void>): Promise<Point> {
  return withDesktopLock(async () => {
    await still?.();
    const outs = await outputs();
    assertPoints(outs, [p]);
    await pointerAct([moveOp(outs, p)]);
    return p;
  });
}

/** Waits up to a second for every surface of an overlay to unmap; returns whether they did. */
async function overlayClosed(namespace: string): Promise<boolean> {
  for (let waited = 0; waited <= 1000; waited += 50) {
    if (!(await layers()).some((l) => l.mapped && l.namespace === namespace)) return true;
    await sleep(50);
  }
  return false;
}

const layerRect = (l: Layer): Rect => ({ x: l.x, y: l.y, width: l.w, height: l.h });

/**
 * Why pointer input at `points` must not be sent, or null to go ahead. By
 * default a shell surface holding the keyboard (launcher, panel, picker) would
 * take the input meant for a window, so it refuses. `overlay` names the
 * layer-shell namespace the caller means to click into (`selection` for slurp):
 * then that overlay must hold the keyboard, and every point must be on a mapped
 * surface of it.
 */
export function inputRefusal(all: readonly Layer[], overlay: string | undefined, points: readonly Point[]): string | null {
  const grab = all.find((l) => l.mapped && l.focused);
  if (!overlay) return grab ? `A shell panel (${grab.namespace}) is open and would take the input; nothing was sent.` : null;
  if (!grab) return `No shell surface has the keyboard, so no ${overlay} overlay is waiting for input; nothing was sent.`;
  if (grab.namespace !== overlay) return `${grab.namespace} has the keyboard, not ${overlay}; nothing was sent.`;
  const surfaces = all.filter((l) => l.mapped && l.namespace === overlay);
  if (!surfaces.length) return `No ${overlay} overlay is open; nothing was sent.`;
  const off = points.find((p) => !surfaces.some((l) => contains(layerRect(l), p)));
  return off ? `${off.x},${off.y} isn't on the ${overlay} overlay; nothing was sent.` : null;
}

/**
 * Runs pointer input at `at` (the current position when null), then puts the
 * user's focus and the pointer back. Holds the desktop lock with
 * focus-follows-mouse paused, refuses while a shell panel is open (it would take
 * the input) unless it's the `overlay` the caller names, and checks the pointer
 * landed before pressing anything, so a user moving the mouse stops it.
 * PUCK_OUTPUTS must allow every point the input reaches, a drag's glide
 * included. Input into an overlay usually closes it (a picker returns its
 * pick), and the compositor then focuses whatever is under the pointer, so
 * once it has closed the user's focus is put back as usual; while it stays
 * open it keeps the keyboard and focus is left alone. The pointer goes back
 * either way.
 */
export async function pointerInput(
  at: Point | null,
  input: (outs: readonly Output[]) => readonly PointerOp[],
  opts: { overlay?: string | undefined; /** fromWindow's check, run under the lock before anything moves. */ still?: (() => Promise<void>) | undefined } = {},
) {
  // Refusals come before withFocus, whose cleanup would warp the cursor to the user's window.
  const outs = await outputs();
  const ops = input(outs); // encoded against the same layout that's checked
  const b = layoutBounds(outs);
  const waypoints = ops.flatMap((o) => (o.op === "move" ? [{ x: o.x + b.x, y: o.y + b.y }] : [])); // e.g. a drag's glide
  const points = [at ?? (await pointerPosition(outs)), ...waypoints];
  assertPoints(outs, points);
  const refusal = inputRefusal(await layers(), opts.overlay, points);
  if (refusal) throw new Error(refusal);
  // The first click usually closes a picker; a second would land on the window beneath.
  if (opts.overlay && ops.filter((o) => o.op === "button" && o.state === "press").length > 1) {
    throw new Error("Into an overlay, click once per call; nothing was sent.");
  }

  let home: Point | undefined;
  return withFocus(
    async (focus) => {
      const start = await probePointer(outs);
      const target = at ? { x: Math.floor(at.x), y: Math.floor(at.y) } : start;
      try {
        assertPoints(outs, [target]); // the pointer may have moved since the check above
      } catch (err) {
        focus.abandon(); // nothing was done; don't warp the cursor
        throw err;
      }
      // Again under the lock and at the exact target, before the last pointer probe:
      // another Puck may have closed the overlay meanwhile.
      const late = inputRefusal(await layers(), opts.overlay, [target, ...waypoints]);
      if (late) {
        focus.abandon(); // nothing was done
        throw new Error(late);
      }
      try {
        await opts.still?.();
      } catch (err) {
        focus.abandon(); // nothing was done
        throw err;
      }
      home = start;
      await pointerAct([moveOp(outs, target)]);
      // Once more, late: a window that opens meanwhile shifts the others. A refusal here
      // takes the usual way out, which puts the pointer back. What moves between this
      // and the press isn't caught.
      await opts.still?.();
      // Last, so nothing comes between it and the press: the user's mouse.
      const landed = await probePointer(outs);
      if (landed.x !== target.x || landed.y !== target.y) {
        home = undefined; // leave the mouse to the user
        focus.abandon();
        throw new Error(
          `The pointer ended at ${landed.x},${landed.y}, not ${target.x},${target.y}; the user may be using the mouse. Nothing was pressed.`,
        );
      }
      await pointerAct(ops);
      if (opts.overlay && !(await overlayClosed(opts.overlay))) focus.leave(); // it still has the keyboard
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
