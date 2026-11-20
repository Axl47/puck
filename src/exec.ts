import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
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

/** False once the live session was chosen (desktop_state, PUCK_DESKTOP=live, the user's own terminal). */
export const followsPrivateDesktop = () => followPrivate;

/** The thread (or, outside T3, the ward) whose private desktop `ward desktop` finds. */
const owner = () => process.env.T3CODE_THREAD_ID || process.env.WARD_ID || undefined;

/**
 * Where Puck notes each thread or ward that has had a private desktop. In the
 * home folder of the user's account, not XDG_STATE_HOME or HOME: a command whose
 * environment differs (a hermetic test runner) must still find the note.
 */
const hadPrivateDir = () => join(userInfo().homedir, ".local/state/puck/private-desktops");
const hadPrivateFile = (who: string) => join(hadPrivateDir(), who.replace(/[^A-Za-z0-9_-]/g, "_"));

/** Notes that `who` has a private desktop, so it never quietly lands on the live session again. */
function notePrivate(who: string | undefined): void {
  if (!who || existsSync(hadPrivateFile(who))) return;
  mkdirSync(hadPrivateDir(), { recursive: true });
  writeFileSync(hadPrivateFile(who), `${who}\n`);
}

/**
 * Starts the agent's private desktop if it isn't up: Ward starts a thread's when
 * a command runs on it. Returns null once it is up, or why there is none to
 * start (no Ward, or neither a ward nor a T3 thread Ward can tell).
 */
export async function startPrivateDesktop(): Promise<string | null> {
  try {
    await promisify(execFile)("ward", ["desktop", "--", "true"], { timeout: 90_000 });
    notePrivate(owner());
    return null;
  } catch (err) {
    const { code, stderr } = err as { code?: string | number; stderr?: string };
    if (code === "ENOENT") return "`ward` isn't on PATH";
    if (code === 3) return stderr?.trim().replace(/^ward: /, "") || "this is neither a T3 thread nor a warded worktree";
    throw new Error(`The private desktop didn't start: ${stderr?.trim() || (err instanceof Error ? err.message : String(err))}`);
  }
}

/** The user's own session folder, whatever this process's XDG_RUNTIME_DIR says. */
const sessionDir = () => `/run/user/${userInfo().uid}`;
const inode = (path: string) => {
  try {
    const { dev, ino } = statSync(path);
    return `${dev}:${ino}`;
  } catch {
    return undefined;
  }
};

/**
 * Whether a private desktop's environment leads to the user's live session: its
 * folder is the session's, or one of its sockets (Wayland, Umbriel, the bus) is
 * one of the session's, by inode, so neither a link nor a renamed path gets past.
 */
export function namesLiveSession(vars: Record<string, string | undefined>, session = sessionDir()): boolean {
  const names = (() => {
    try {
      return readdirSync(session);
    } catch {
      return []; // no session here
    }
  })();
  const live = new Set(names.map((name) => join(session, name)).filter((path) => lstatSync(path, { throwIfNoEntry: false })?.isSocket()).map(inode));
  live.delete(undefined);
  const runtime = vars.XDG_RUNTIME_DIR ?? "";
  const wayland = vars.WAYLAND_DISPLAY && (isAbsolute(vars.WAYLAND_DISPLAY) ? vars.WAYLAND_DISPLAY : join(runtime, vars.WAYLAND_DISPLAY));
  const bus = /(?:^|;)unix:path=([^,;]+)/.exec(vars.DBUS_SESSION_BUS_ADDRESS ?? "")?.[1];
  const sameDir = (() => {
    try {
      return realpathSync(runtime) === realpathSync(session);
    } catch {
      return false;
    }
  })();
  return sameDir || [wayland, vars.UMBRIEL_SOCKET, bus].some((path) => path && live.has(inode(path)));
}

/**
 * The environment of the agent's private desktop, from `ward desktop` (a few ms
 * once the desktop is up). In a ward that starts the ward and its desktop when
 * they aren't up; elsewhere it answers from the thread's first open on
 * (`puck open`, launch_app, `ward desktop -- CMD`), restarting a desktop that
 * stopped meanwhile. null when there is none, which a thread or ward that has
 * had one never gets: Ward forgetting it must not put it on the user's screen.
 */
async function privateDesktop(): Promise<DesktopEnv | null> {
  let stdout: string;
  try {
    ({ stdout } = await promisify(execFile)("ward", ["desktop"], { encoding: "utf8", timeout: 90_000 }));
  } catch (err) {
    // No Ward on this machine (and not in a ward, where it must be), or it says
    // there is no private desktop here (exit 3): the live session, unless this
    // thread had one. Anything else is a desktop that didn't start, and falling
    // back would put this agent's windows on the user's screen.
    const { code, stderr } = err as { code?: string | number; stderr?: string };
    const who = owner();
    if (code === 3 && who && existsSync(hadPrivateFile(who))) {
      throw new Error(
        `This thread had a private desktop, but Ward no longer gives it one (${stderr?.trim().replace(/^ward: /, "") || "exit 3"}), and Puck won't fall back to the user's screen. \`puck open CMD\` starts it again; for the user's screen, use the live session explicitly (PUCK_DESKTOP=live, or desktop_state with desktop "live").`,
      );
    }
    if ((code === "ENOENT" && !process.env.WARD_ID) || code === 3) return null;
    if (code === "ENOENT") throw new Error("This is a ward, but `ward` isn't on PATH, so its desktop can't be found.");
    throw new Error(`The private desktop didn't start: ${stderr?.trim() || (err instanceof Error ? err.message : String(err))}`);
  }
  const vars = Object.fromEntries(
    stdout
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  const { XDG_RUNTIME_DIR } = vars;
  if (!XDG_RUNTIME_DIR || !vars.WAYLAND_DISPLAY) throw new Error(`The private desktop didn't start: \`ward desktop\` printed no desktop: ${stdout.trim()}`);
  // Ward keeps its files where any program of the user can write: never take the user's screen for a private desktop.
  if (namesLiveSession(vars)) {
    throw new Error("`ward desktop` named the user's live session as this agent's private desktop, so Puck won't act on it as one. For the user's screen, use the live session explicitly (PUCK_DESKTOP=live, or desktop_state with desktop \"live\").");
  }
  notePrivate(owner());
  // Without what would still point a helper at the live session: an inherited
  // Wayland socket, which wins over WAYLAND_DISPLAY, and its accessibility bus.
  const { WAYLAND_SOCKET: _socket, AT_SPI_BUS_ADDRESS: _a11y, ...inherited } = process.env;
  return { ...inherited, ...vars, XDG_RUNTIME_DIR };
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
