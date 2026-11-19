import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";

export const runtimeDir = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`;

let cachedDisplay: string | undefined;

/**
 * The Wayland display Umbriel serves. Agents launched by the T3 service have no
 * WAYLAND_DISPLAY, so fall back to the compositor's own socket name
 * (`umbriel-<display>.sock`), preferring `wayland-0`.
 */
export function waylandDisplay(): string {
  if (process.env.WAYLAND_DISPLAY) return process.env.WAYLAND_DISPLAY;
  if (cachedDisplay) return cachedDisplay;
  const displays = readdirSync(runtimeDir)
    .map((f) => /^umbriel-(.+)\.sock$/.exec(f)?.[1])
    .filter((d): d is string => d !== undefined)
    .sort((a, b) => (a === "wayland-0" ? -1 : b === "wayland-0" ? 1 : a.localeCompare(b)));
  const found = displays[0];
  if (!found) throw new Error(`No Umbriel socket in ${runtimeDir}. Is the Umbriel session running?`);
  cachedDisplay = found;
  return found;
}

/** Environment for every desktop child process. */
export function desktopEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    XDG_RUNTIME_DIR: runtimeDir,
    WAYLAND_DISPLAY: waylandDisplay(),
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=${runtimeDir}/bus`,
  };
}

export class CommandError extends Error {
  constructor(
    readonly command: string,
    readonly stderr: string,
  ) {
    super(stderr.trim() || `${command} failed`);
  }
}

type RunOptions = { timeoutMs?: number };

/** Runs a desktop CLI and returns stdout as text. Throws CommandError with the tool's stderr. */
export function run(cmd: string, args: readonly string[], opts: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { env: desktopEnv(), timeout: opts.timeoutMs ?? 10_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new CommandError([cmd, ...args].join(" "), stderr || err.message));
        else resolve(stdout);
      },
    );
  });
}

/** Like run, but returns stdout as raw bytes (screenshots). */
export function runBinary(cmd: string, args: readonly string[], opts: RunOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        env: desktopEnv(),
        timeout: opts.timeoutMs ?? 15_000,
        maxBuffer: 64 * 1024 * 1024,
        encoding: "buffer",
      },
      (err, stdout, stderr) => {
        if (err) reject(new CommandError([cmd, ...args].join(" "), stderr.toString() || err.message));
        else resolve(stdout);
      },
    );
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
