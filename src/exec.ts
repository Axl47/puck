import { execFile, execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";

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

type DesktopVars = Record<string, string> & { XDG_RUNTIME_DIR: string };

/** How long an answer from `ward desktop` stands before asking again (the ward may have stopped). */
const WARD_FRESH_MS = 2000;
let followWard = false;
/** The last answer from `ward desktop`; null vars: this folder has no ward. */
let ward: { vars: DesktopVars | null; at: number } | undefined;

/**
 * Whether to act on the ward's desktop when this process's folder has one.
 * Off by default, so the CLI acts on the desktop its environment names
 * (`ward desktop -- puck …` for a ward's). The MCP server turns it on: it is
 * one process outside the ward, so it can't be given that environment per call.
 */
export function followWardDesktop(on: boolean): void {
  followWard = on;
}

/**
 * The environment of this folder's ward desktop, from `ward desktop`, which
 * starts the ward and the desktop when they aren't up; null when the folder has
 * no ward. `reuse` takes the last answer however old, starting nothing.
 */
function wardDesktop(reuse: boolean): DesktopVars | null {
  if (ward && (ward.vars === null || reuse || Date.now() - ward.at < WARD_FRESH_MS)) return ward.vars;
  let vars: DesktopVars | null = null;
  try {
    const out = execFileSync("ward", ["desktop"], { encoding: "utf8", timeout: 90_000, stdio: ["ignore", "pipe", "pipe"] });
    const parsed = Object.fromEntries(
      out
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    const { XDG_RUNTIME_DIR } = parsed;
    if (!XDG_RUNTIME_DIR || !parsed.WAYLAND_DISPLAY) throw new Error(`\`ward desktop\` printed no desktop: ${out.trim()}`);
    vars = { ...parsed, XDG_RUNTIME_DIR };
  } catch (err) {
    // No Ward on this machine, or it says this folder has none (exit 3): the live
    // session. Anything else is a ward desktop that didn't start, and falling
    // back would put this agent's windows on the user's screen.
    const { code, status, stderr } = err as { code?: string; status?: number; stderr?: string };
    if (code !== "ENOENT" && status !== 3) {
      throw new Error(`This ward's desktop didn't start: ${stderr?.trim() || (err instanceof Error ? err.message : String(err))}`);
    }
  }
  ward = { vars, at: Date.now() };
  return vars;
}

/** Which desktop Puck is acting on. */
export const desktop = (): Desktop => (followWard && wardDesktop(false) ? "ward" : "live");

/** Environment for every desktop child process. `reuse`: see wardDesktop. */
export function desktopEnv(reuse = false): NodeJS.ProcessEnv & { XDG_RUNTIME_DIR: string } {
  const vars = followWard ? wardDesktop(reuse) : null;
  if (vars) return { ...process.env, ...vars };
  return {
    ...process.env,
    XDG_RUNTIME_DIR: liveRuntimeDir,
    WAYLAND_DISPLAY: waylandDisplay(),
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=${liveRuntimeDir}/bus`,
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
