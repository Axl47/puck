import { z } from "zod";
import { CommandError, run } from "./exec.ts";
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

let queue: Promise<unknown> = Promise.resolve();

type FocusOptions = {
  /** Put focus back on the user's window afterwards (when it's still on screen), instead of leaving it where the action put it. */
  restoreFocus: boolean;
  /** Outputs whose visible workspace the action is meant to change. Every other output gets its workspace back. */
  shows?: readonly string[] | "all";
};

/**
 * Runs `fn` with exclusive control of focus. Most Umbriel actions apply to the
 * focused window on the output under the cursor, so a sequence must focus (and
 * warp to) its target first, and focusing a window on a hidden workspace shows
 * that workspace. So for the duration focus-follows-mouse is paused (the user's
 * mouse can't steal focus mid-sequence); afterwards each output not in `shows`
 * gets its visible workspace back, and focus lands on the user's window or the
 * action's, per `restoreFocus`.
 */
export function withFocus<T>(fn: () => Promise<T>, opts: FocusOptions): Promise<T> {
  const task = queue.then(async () => {
    const [original, before] = await Promise.all([focusedWindow(), outputs()]);
    await run("umbriel", ["config", "set", "input.focus.follows_mouse", '"off"']);
    try {
      return await fn();
    } finally {
      try {
        const [ended, now, wss] = await Promise.all([focusedWindow(), outputs(), workspaces()]);
        const allowed = allowedOutputs();
        for (const o of before) {
          if (!o.active_workspace || opts.shows === "all" || opts.shows?.includes(o.name)) continue;
          if (allowed && !allowed.includes(o.name)) continue; // never touch outputs outside PUCK_OUTPUTS
          const ws = wss.find((ws) => ws.id === o.active_workspace);
          const current = now.find((n) => n.name === o.name)?.active_workspace;
          if (ws && current !== ws.id) await msg("workspace-switch", ...workspaceArgs(ws));
        }
        const target = opts.restoreFocus ? original : ended;
        if (target && (await windows()).find((w) => w.id === target.id)?.visible) {
          await msg("window-focus-warp", target.id);
        }
      } finally {
        await run("umbriel", ["config", "unset", "input.focus.follows_mouse"]).catch(() => {});
      }
    }
  });
  queue = task.catch(() => {});
  return task;
}

/** Focuses a window and moves the cursor onto it, so focused-output actions target it. */
export const focusOn = (id: string) => msg("window-focus-warp", id);
