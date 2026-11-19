import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { promisify } from "node:util";

const liveRuntimeDir = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`;

let cachedDisplay: string | undefined;

/**
 * The Wayland display the live Umbriel serves. Agents launched by the T3 service
 * have no WAYLAND_DISPLAY, so fall back to the compositor's own socket name
 * (`umbriel-<display>.sock`), preferring `wayland-0`.
 */
export function waylandDisplay(): string {
  if (process.env.WAYLAND_DISPLAY) return process.env.WAYLAND_DISPLAY;
  if (cachedDisplay) return cachedDisplay;
  const displays = readdirSync(liveRuntimeDir)
    .map((f) => /^umbriel-(.+)\.sock$/.exec(f)?.[1])
    .filter((d): d is string => d !== undefined)
    .sort((a, b) => (a === "wayland-0" ? -1 : b === "wayland-0" ? 1 : a.localeCompare(b)));
  const found = displays[0];
  if (!found) throw new Error(`No Umbriel socket in ${liveRuntimeDir}. Is the Umbriel session running?`);
  cachedDisplay = found;
  return found;
}

/** The desktop Puck acts on: a ward's private headless one, or the user's live session. */
export type Desktop = "ward" | "live";

type DesktopEnv = NodeJS.ProcessEnv & { XDG_RUNTIME_DIR: string };

const liveEnv = (): DesktopEnv => ({
  ...process.env,
  XDG_RUNTIME_DIR: liveRuntimeDir,
  WAYLAND_DISPLAY: waylandDisplay(),
  DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=${liveRuntimeDir}/bus`,
});

let followWard = false;

/**
 * Whether onDesktop picks the ward's desktop when this process's folder has
 * one. The MCP server turns it on (desktop_state can turn it off again); the
 * CLI turns it on inside a ward.
 */
export function followWardDesktop(on: boolean): void {
  followWard = on;
}

/**
 * The environment of this folder's ward desktop, from `ward desktop`, which
 * starts the ward and the desktop when they aren't up (a few ms once they are);
 * null when the folder has no ward.
 */
async function wardDesktop(): Promise<DesktopEnv | null> {
  try {
    const { stdout } = await promisify(execFile)("ward", ["desktop"], { encoding: "utf8", timeout: 90_000 });
    const vars = Object.fromEntries(
      stdout
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    const { XDG_RUNTIME_DIR } = vars;
    if (!XDG_RUNTIME_DIR || !vars.WAYLAND_DISPLAY) throw new Error(`\`ward desktop\` printed no desktop: ${stdout.trim()}`);
    return { ...process.env, ...vars, XDG_RUNTIME_DIR };
  } catch (err) {
    // No Ward on this machine, or it says this folder has none (exit 3): the live
    // session. Anything else is a ward desktop that didn't start, and falling
    // back would put this agent's windows on the user's screen.
    const { code, stderr } = err as { code?: string | number; stderr?: string };
    if (code === "ENOENT" || code === 3) return null;
    throw new Error(`This ward's desktop didn't start: ${stderr?.trim() || (err instanceof Error ? err.message : String(err))}`);
  }
}

const chosen = new AsyncLocalStorage<{ desktop: Desktop; env: DesktopEnv }>();

/**
 * Runs `fn` on the desktop chosen now, start to finish: every MCP tool call and
 * CLI command runs inside one, so a switch made meanwhile (desktop_state), or a
 * ward that restarts, can't move half of it to another desktop.
 */
export async function onDesktop<T>(fn: () => T | Promise<T>): Promise<T> {
  const env = followWard ? await wardDesktop() : null;
  return chosen.run(env ? { desktop: "ward", env } : { desktop: "live", env: liveEnv() }, fn);
}

/** Which desktop the running call acts on; the live session outside onDesktop. */
export const desktop = (): Desktop => chosen.getStore()?.desktop ?? "live";

/** Environment for every desktop child process. */
export const desktopEnv = (): DesktopEnv => chosen.getStore()?.env ?? liveEnv();

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
