import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runBinary } from "./exec.ts";
import { stateDir } from "./paths.ts";

/** Long edge, in pixels, of screenshots returned inline. Larger images cost agents more tokens without helping. */
export const INLINE_LONG_EDGE = 1568;

export type CaptureTarget =
  | { kind: "output"; name: string; width: number; height: number; scale: number }
  | { kind: "window"; id: string; width: number; height: number; scale: number }
  | { kind: "region"; x: number; y: number; width: number; height: number; scale: number };

/**
 * Pixels per logical pixel in the result. Inline shots are capped at
 * INLINE_LONG_EDGE; full-resolution shots use the output's own scale.
 */
export function captureDensity(t: CaptureTarget, fullRes: boolean): number {
  return fullRes ? t.scale : Math.min(t.scale, INLINE_LONG_EDGE / Math.max(t.width, t.height));
}

/** grim's `-s` factor: relative to logical pixels for outputs and regions, but to the buffer for windows. */
export const grimScale = (t: CaptureTarget, density: number) => (t.kind === "window" ? density / t.scale : density);

function grimArgs(t: CaptureTarget): string[] {
  switch (t.kind) {
    case "output":
      return ["-o", t.name];
    case "window":
      return ["-T", t.id];
    case "region":
      return ["-g", `${t.x},${t.y} ${t.width}x${t.height}`];
  }
}

export type Capture = { data: Buffer; mimeType: "image/jpeg" | "image/png"; width: number; height: number };

/** Inline shot: scaled JPEG bytes. */
export async function capture(t: CaptureTarget): Promise<Capture> {
  const d = captureDensity(t, false);
  const data = await runBinary("grim", [...grimArgs(t), "-s", grimScale(t, d).toFixed(4), "-t", "jpeg", "-q", "85", "-"]);
  return { data, mimeType: "image/jpeg", width: Math.round(t.width * d), height: Math.round(t.height * d) };
}

/** Full-resolution PNG saved at `path` (default: under Puck's state dir); returns its absolute path. */
export async function captureToFile(t: CaptureTarget, path?: string): Promise<string> {
  const s = grimScale(t, captureDensity(t, true));
  const data = await runBinary("grim", [...grimArgs(t), "-s", s.toFixed(4), "-t", "png", "-"]);
  const dest = resolve(path ?? join(stateDir(), "screenshots", `${new Date().toISOString().replace(/[:.]/g, "-")}-${t.kind}.png`));
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, data);
  return dest;
}
