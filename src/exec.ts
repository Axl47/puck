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

/**
 * The desktop Puck acts on: the agent's private headless one (its ward's, or
 * where there is no ward its T3 thread's own, once something was opened on it),
 * or the user's live session.
 */
export type Desktop = "private" | "live";

type DesktopEnv = NodeJS.ProcessEnv & { XDG_RUNTIME_DIR: string };

const liveEnv = (): DesktopEnv => ({
  ...process.env,
  XDG_RUNTIME_DIR: liveRuntimeDir,
  WAYLAND_DISPLAY: waylandDisplay(),
  DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=${liveRuntimeDir}/bus`,
});

let followPrivate = false;

/**
 * Whether onDesktop picks the agent's private desktop when it has one. The MCP
 * server turns it on (desktop_state can turn it off again); the CLI turns it on
 * for an agent (in a ward, or a T3 thread).
 */
export function followPrivateDesktop(on: boolean): void {
  followPrivate = on;
}

/**
 * The environment of the agent's private desktop, from `ward desktop` (a few ms
 * once the desktop is up). In a ward that starts the ward and its desktop when
 * they aren't up; elsewhere it only answers once the thread opened something
 * (`puck open`, `ward desktop -- CMD`). null when there is none.
 */
async function privateDesktop(): Promise<DesktopEnv | null> {
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
    // Without what would still point a helper at the live session: an inherited
    // Wayland socket, which wins over WAYLAND_DISPLAY, and its accessibility bus.
    const { WAYLAND_SOCKET: _socket, AT_SPI_BUS_ADDRESS: _a11y, ...inherited } = process.env;
    return { ...inherited, ...vars, XDG_RUNTIME_DIR };
  } catch (err) {
    // No Ward on this machine (and not in a ward, where it must be), or it says
    // there is no private desktop here (exit 3): the live session. Anything else
    // is a desktop that didn't start, and falling back would put this agent's
    // windows on the user's screen.
    const { code, stderr } = err as { code?: string | number; stderr?: string };
    if ((code === "ENOENT" && !process.env.WARD_ID) || code === 3) return null;
    if (code === "ENOENT") throw new Error("This is a ward, but `ward` isn't on PATH, so its desktop can't be found.");
    throw new Error(`The private desktop didn't start: ${stderr?.trim() || (err instanceof Error ? err.message : String(err))}`);
  }
}

const chosen = new AsyncLocalStorage<{ desktop: Desktop; env: DesktopEnv }>();

/**
 * Runs `fn` on the desktop chosen now, start to finish: every MCP tool call and
 * CLI command runs inside one, so a switch made meanwhile (desktop_state), or a
 * desktop that starts or restarts, can't move half of it to another desktop.
 */
export async function onDesktop<T>(fn: () => T | Promise<T>): Promise<T> {
  const env = followPrivate ? await privateDesktop() : null;
  return chosen.run(env ? { desktop: "private", env } : { desktop: "live", env: liveEnv() }, fn);
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
