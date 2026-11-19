import { z } from "zod";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CommandError, desktopEnv, run, runtimeDir } from "./exec.ts";
import { allowedOutputs } from "./scope.ts";

// Umbriel's `--json` output, trimmed to the fields Puck uses. Unknown keys are dropped.

const WindowSchema = z.object({
  id: z.string(),
  app_id: z.string(),
  title: z.string(),
  pid: z.number(),
  workspace: z.string(),
  output: z.string(),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  visible: z.boolean(),
  floating: z.boolean(),
  fullscreen: z.boolean(),
  maximized: z.boolean(),
  minimized: z.boolean(),
  pinned: z.boolean(),
  urgent: z.boolean(),
  scratchpad: z.string(),
  xwayland: z.boolean(),
});

const WorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Configured workspaces persist; unnamed ones are dynamic and vanish (renumbering the rest) when empty. */
  named: z.boolean(),
  index: z.number(),
  output: z.string(),
  layout: z.string(),
  active: z.boolean(),
  focused: z.boolean(),
  window_count: z.number(),
});

const OutputSchema = z.object({
  name: z.string(),
  enabled: z.boolean(),
  focused: z.boolean(),
  scale: z.number(),
  active_workspace: z.string().nullable(),
  position: z.object({ x: z.number(), y: z.number() }),
  logical_size: z.object({ width: z.number(), height: z.number() }),
  usable_area: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
});

export type Window = z.infer<typeof WindowSchema>;
export type Workspace = z.infer<typeof WorkspaceSchema>;
export type Output = z.infer<typeof OutputSchema>;

export const LAYOUTS = ["scrolling", "dwindle", "master", "stacking"] as const;
export type Layout = (typeof LAYOUTS)[number];

export const parseWindows = (json: unknown) => z.array(WindowSchema).parse(json);
export const parseWorkspaces = (json: unknown) => z.array(WorkspaceSchema).parse(json);
export const parseOutputs = (json: unknown) => z.array(OutputSchema).parse(json);

const inspect = async (command: string) => JSON.parse(await run("umbriel", [command, "--json"])) as unknown;

export const windows = async () => parseWindows(await inspect("windows"));
export const workspaces = async () => parseWorkspaces(await inspect("workspaces"));
export const outputs = async () => parseOutputs(await inspect("outputs"));

/** The window with keyboard focus, or null when nothing is focused. */
export async function focusedWindow(): Promise<Window | null> {
  try {
    return WindowSchema.parse(await inspect("focused-window"));
  } catch (err) {
    if (err instanceof CommandError && /no focused window/.test(err.message)) return null;
    throw err;
  }
}

const LayerSchema = z.object({ namespace: z.string(), output: z.string(), mapped: z.boolean(), focused: z.boolean() });

/**
 * The shell surface (an open panel, launcher, lock screen) holding the
 * keyboard, if any. Meanwhile no window gets keys, though focused-window still
 * names one.
 */
export async function keyboardGrab() {
  return z.array(LayerSchema).parse(await inspect("layers")).find((l) => l.mapped && l.focused) ?? null;
}

/** Runs a compositor action, exactly as a keybind would. */
export async function msg(action: string, ...args: string[]): Promise<void> {
  await run("umbriel", ["msg", action, ...args]);
}

export async function snapshot() {
  const [w, ws, o, f] = await Promise.all([windows(), workspaces(), outputs(), focusedWindow()]);
  return { windows: w, workspaces: ws, outputs: o, focused: f };
}
export type Snapshot = Awaited<ReturnType<typeof snapshot>>;

/** CLI arguments that name a workspace by its id (`DP-2:8`): its name plus `--output`. */
export function workspaceArgs(ws: Workspace): string[] {
  return [ws.name, "--output", ws.output];
}

export function findWindow(snap: Pick<Snapshot, "windows">, id: string): Window {
  const w = snap.windows.find((w) => w.id === id);
  if (!w) throw new Error(`No window with id ${id}. Call desktop_state for current ids.`);
  return w;
}

export function findWorkspace(snap: Pick<Snapshot, "workspaces">, id: string): Workspace {
  const ws = snap.workspaces.find((ws) => ws.id === id);
  if (!ws) throw new Error(`No workspace with id ${id}. Call desktop_state for current ids.`);
  return ws;
}

export function findOutput(snap: Pick<Snapshot, "outputs">, name: string): Output {
  const o = snap.outputs.find((o) => o.name === name && o.enabled);
  if (!o) throw new Error(`No enabled output named ${name}.`);
  return o;
}


const FOLLOWS_MOUSE = "input.focus.follows_mouse";
const lockPath = () => join(runtimeDir, "puck.lock");
/** Holds the user's focus-follows-mouse value while an action has it paused. */
const pausedPath = () => join(runtimeDir, "puck-follows-mouse");

/**
 * Takes the desktop lock every Puck process shares (each agent's MCP server,
 * `puck restore`). `flock` holds it while its stdin stays open, so the kernel
 * frees it if this process dies, and first puts back a focus-follows-mouse
 * value a dead holder left paused (even after SIGKILL).
 */
async function lockDesktop(): Promise<() => void> {
  const script = `echo; cat; f=$1; [ -f "$f" ] || exit 0
umbriel config unset ${FOLLOWS_MOUSE}
[ "$(umbriel config get ${FOLLOWS_MOUSE})" = "$(cat "$f")" ] || umbriel config set ${FOLLOWS_MOUSE} "\"$(cat "$f")\""
rm -f "$f"`;
  const child = spawn("flock", ["--timeout", "120", lockPath(), "sh", "-c", script, "sh", pausedPath()], {
    env: desktopEnv(),
    stdio: ["pipe", "pipe", "ignore"],
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve());
    child.once("error", reject);
    child.once("exit", () => reject(new Error("Another Puck session held the desktop for 2 minutes; try again.")));
  });
  return () => child.stdin.end();
}

/**
 * Puts back the focus-follows-mouse value recorded at pausedPath, if any.
 * `unset` drops Puck's override; the recorded value is set again only if the
 * user had an override of their own. Synchronous so it can run on exit.
 */
function resumeFollowsMouse(): void {
  if (!existsSync(pausedPath())) return;
  const want = readFileSync(pausedPath(), "utf8");
  const umbriel = (...args: string[]) => execFileSync("umbriel", ["config", ...args], { env: desktopEnv(), encoding: "utf8" });
  umbriel("unset", FOLLOWS_MOUSE);
  if (umbriel("get", FOLLOWS_MOUSE).trim() !== want) umbriel("set", FOLLOWS_MOUSE, JSON.stringify(want));
  rmSync(pausedPath(), { force: true }); // a dying holder's flock child may race us to it
}

let pausedHere = false;
process.once("exit", () => {
  if (pausedHere) resumeFollowsMouse();
});
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.once(signal, () => process.exit(1));

/** Focus control handed to an action running inside withFocus. */
export type Focus = {
  /** Focuses a window and warps the cursor onto it, then confirms it holds focus. */
  on(id: string): Promise<void>;
  /** Focuses `id`, then runs an action that applies to the focused window, accepting where focus lands. */
  act(id: string, action: string, ...args: string[]): Promise<void>;
  /** Shows a workspace on its output, which also focuses that output. */
  show(ws: Workspace): Promise<void>;
  /** Accepts whatever holds focus now as the action's doing (e.g. a window it launched). */
  settle(): Promise<void>;
  /** The user took over (e.g. moved the mouse): leave focus and the cursor as they are. */
  abandon(): void;
};

type FocusOptions = {
  /** Put focus back on the user's window afterwards, instead of leaving it where the action put it. */
  restoreFocus: boolean;
  /** Outputs whose visible workspace the action is meant to change. Every other output gets its workspace back. */
  shows?: readonly string[] | "all";
  /** Runs after focus is put back, still under the lock with focus-follows-mouse paused (e.g. returning the pointer). */
  cleanup?: () => Promise<void>;
};

let queue: Promise<unknown> = Promise.resolve();

/**
 * Runs `fn` with exclusive control of focus, across every Puck process. Most
 * Umbriel actions apply to the focused window on the output under the cursor,
 * so a sequence must focus (and warp to) its target first, and focusing a
 * window on a hidden workspace shows that workspace. So for the duration
 * focus-follows-mouse is paused; afterwards each output not in `shows` gets its
 * visible workspace back, and focus lands on the user's window or the
 * action's, per `restoreFocus`. If focus ends up somewhere the action didn't
 * put it, the user took over, and their changes are left alone.
 */
export function withFocus<T>(fn: (focus: Focus) => Promise<T>, opts: FocusOptions): Promise<T> {
  const task = queue.then(async () => {
    const release = await lockDesktop();
    try {
      resumeFollowsMouse(); // a Puck that died mid-action left it paused
      const [original, before, follows] = await Promise.all([
        focusedWindow(),
        outputs(),
        run("umbriel", ["config", "get", FOLLOWS_MOUSE]),
      ]);
      writeFileSync(pausedPath(), follows.trim());
      pausedHere = true;
      await run("umbriel", ["config", "set", FOLLOWS_MOUSE, '"off"']);

      let expected = original?.id ?? null;
      let abandoned = false;
      const focus: Focus = {
        async on(id) {
          await msg("window-focus-warp", id);
          expected = id;
          if ((await focusedWindow())?.id !== id) {
            throw new Error(`Couldn't focus window ${id}; the user may be using the desktop. Stopped there.`);
          }
        },
        async act(id, action, ...args) {
          await focus.on(id);
          await msg(action, ...args);
          await focus.settle(); // moving a window away hands focus to its neighbour
        },
        async show(ws) {
          await msg("workspace-switch", ...workspaceArgs(ws));
          await focus.settle();
        },
        async settle() {
          expected = (await focusedWindow())?.id ?? null;
        },
        abandon() {
          abandoned = true;
        },
      };

      try {
        return await fn(focus);
      } finally {
        try {
          try {
            if (!abandoned) await putBack(original?.id ?? null, before, expected, opts);
          } finally {
            await opts.cleanup?.();
          }
        } finally {
          resumeFollowsMouse();
          pausedHere = false;
        }
      }
    } finally {
      release();
    }
  });
  queue = task.catch(() => {});
  return task;
}

/**
 * Runs `fn` holding the desktop lock, without touching focus: for pointer
 * reads and moves, which must not interleave with another Puck's input.
 */
export function withDesktopLock<T>(fn: () => Promise<T>): Promise<T> {
  const task = queue.then(async () => {
    const release = await lockDesktop();
    try {
      return await fn();
    } finally {
      release();
    }
  });
  queue = task.catch(() => {});
  return task;
}

/** The cleanup half of withFocus. */
async function putBack(original: string | null, before: Output[], expected: string | null, opts: FocusOptions) {
  const [ended, now, wss, wins] = await Promise.all([focusedWindow(), outputs(), workspaces(), windows()]);
  if ((ended?.id ?? null) !== expected) return; // the user took over mid-action
  const allowed = allowedOutputs();
  for (const o of before) {
    if (!o.active_workspace || opts.shows === "all" || opts.shows?.includes(o.name)) continue;
    if (allowed && !allowed.includes(o.name)) continue; // never touch outputs outside PUCK_OUTPUTS
    const ws = wss.find((ws) => ws.id === o.active_workspace);
    if (ws && now.find((n) => n.name === o.name)?.active_workspace !== ws.id) await msg("workspace-switch", ...workspaceArgs(ws));
  }
  const target = opts.restoreFocus ? original : (ended?.id ?? null);
  if (target && wins.find((w) => w.id === target)?.visible) {
    await msg("window-focus-warp", target);
  } else if (opts.restoreFocus && !original) {
    // The user was on an empty workspace: focus that output again.
    const home = before.find((o) => o.focused);
    const ws = home && wss.find((ws) => ws.id === home.active_workspace);
    if (ws) await msg("workspace-switch", ...workspaceArgs(ws));
  }
}
