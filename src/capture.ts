import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runBinary } from "./exec.ts";
import { stateDir } from "./paths.ts";

/** Long edge, in pixels, of screenshots returned inline. Larger images cost agents more tokens without helping. */
export const INLINE_LONG_EDGE = 1568;

export type CaptureTarget =
  | { kind: "output"; name: string; width: number; height: number; scale: number }
  | { kind: "window"; id: string; width: number; height: number; scale: number }
  | { kind: "region"; x: number; y: number; width: number; height: number; scale: number };

/**
 * grim's `-s` factor is relative to logical pixels. Inline shots are capped at
 * INLINE_LONG_EDGE; full-resolution shots use the output's own scale.
 */
export function captureScale(t: CaptureTarget, fullRes: boolean): number {
  if (fullRes) return t.scale;
  const longEdge = Math.max(t.width, t.height);
  return Math.min(t.scale, INLINE_LONG_EDGE / longEdge);
}

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
  const s = captureScale(t, false);
  const data = await runBinary("grim", [...grimArgs(t), "-s", s.toFixed(4), "-t", "jpeg", "-q", "85", "-"]);
  return { data, mimeType: "image/jpeg", width: Math.round(t.width * s), height: Math.round(t.height * s) };
}

/** Full-resolution PNG saved under Puck's state dir; returns its path. */
export async function captureToFile(t: CaptureTarget): Promise<string> {
  const data = await runBinary("grim", [...grimArgs(t), "-s", captureScale(t, true).toFixed(4), "-t", "png", "-"]);
  const dir = join(stateDir(), "screenshots");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${t.kind}.png`);
  writeFileSync(path, data);
  return path;
}
