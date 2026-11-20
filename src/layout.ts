import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { desktop, desktopEnv, run } from "./exec.ts";
import { stateDir } from "./paths.ts";
import { allowedOutputs } from "./scope.ts";
import {
  type Snapshot,
  type Window,
  type Workspace,
  msg,
  outputs,
  snapshot,
  windows,
  withFocus,
  workspaceArgs,
  workspaces,
} from "./umbriel.ts";

/**
 * How a snapshot names a workspace. Named workspaces are found by name.
 * Unnamed (dynamic) ones keep their id until they vanish when emptied, so they
 * are found by id while it exists, then by the windows they held.
 */
const WorkspaceRefSchema = z.object({
  id: z.string(),
  output: z.string(),
  name: z.string(),
  named: z.boolean(),
  /** Windows on a dynamic workspace when recorded; empty for named ones. */
  windows: z.array(z.string()),
});
export type WorkspaceRef = z.infer<typeof WorkspaceRefSchema>;

/** Everything layout_restore puts back. Column order within a workspace is not recorded. */
const LayoutSnapshotSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  /** The runtime folder of the desktop it was taken on; snapshots from before private desktops have none. */
  desktop: z.string().optional(),
  /** Outputs recorded; null for all. */
  scope: z.array(z.string()).nullable(),
  focused: z.string().nullable(),
  /** Every workspace on the recorded outputs, empty ones too (arranging may fill them). */
  workspaces: z.array(z.object({ ref: WorkspaceRefSchema, layout: z.string(), active: z.boolean() })),
  windows: z.array(
    z.object({
      id: z.string(),
      workspace: WorkspaceRefSchema,
      floating: z.boolean(),
      fullscreen: z.boolean(),
      /** Column width as a fraction of the output, for tiled windows on scrolling workspaces. */
      extent: z.number().nullable(),
    }),
  ),
});
export type LayoutSnapshot = z.infer<typeof LayoutSnapshotSchema>;

type Placed = Pick<Window, "id" | "workspace">;

/**
 * The workspace a ref points at now. A dynamic one is, in order: the same
 * workspace if it still exists; else the one holding any of its windows already
 * put back (`placed`), one holding only its windows, or an empty one (Umbriel
 * keeps one trailing empty workspace).
 */
export function resolveRef(
  ref: WorkspaceRef,
  wss: readonly Workspace[],
  wins: readonly Placed[],
  placed: ReadonlySet<string>,
): Workspace | undefined {
  const mine = wss.filter((ws) => ws.output === ref.output && ws.named === ref.named);
  if (ref.named) return mine.find((ws) => ws.name === ref.name);
  const same = mine.find((ws) => ws.id === ref.id);
  if (same) return same;
  const members = new Set(ref.windows);
  const on = (ws: Workspace) => wins.filter((w) => w.workspace === ws.id);
  return (
    mine.find((ws) => on(ws).some((w) => members.has(w.id) && placed.has(w.id))) ??
    mine.find((ws) => {
      const here = on(ws);
      return here.length > 0 && here.every((w) => members.has(w.id));
    }) ??
    mine.findLast((ws) => on(ws).length === 0)
  );
}

const describeRef = (ref: WorkspaceRef) => (ref.named ? `${ref.output} ${ref.name}` : `a workspace on ${ref.output}`);

type Geometry = { gap: number; border: number };

async function geometry(): Promise<Geometry> {
  const get = async (key: string) => Number((await run("umbriel", ["config", "get", key])).trim());
  const [gap, border] = await Promise.all([get("layout.gap"), get("appearance.border_width")]);
  return { gap, border };
}

/**
 * A scrolling column of fraction f on an output of usable width W is
 * f * (W - gap) - gap - 2 * border pixels wide; this inverts that.
 */
export function extentOf(width: number, usableWidth: number, g: Geometry): number {
  return (width + g.gap + 2 * g.border) / (usableWidth - g.gap);
}

/** Records the layout of the `scope` outputs (every output when omitted). */
export function takeSnapshot(snap: Snapshot, g: Geometry, scope?: readonly string[]): LayoutSnapshot {
  const inScope = (output: string) => !scope || scope.includes(output);
  const live = snap.windows.filter((w) => !w.scratchpad);
  const refOf = (ws: Workspace): WorkspaceRef => ({
    id: ws.id,
    output: ws.output,
    name: ws.name,
    named: ws.named,
    windows: ws.named ? [] : live.filter((w) => w.workspace === ws.id).map((w) => w.id),
  });
  const wsById = new Map(snap.workspaces.map((ws) => [ws.id, ws]));
  const usable = new Map(snap.outputs.map((o) => [o.name, o.usable_area.width]));
  return {
    id: randomUUID().slice(0, 8),
    createdAt: new Date().toISOString(),
    scope: scope ? [...scope] : null,
    focused: snap.focused && inScope(snap.focused.output) ? snap.focused.id : null,
    workspaces: snap.workspaces
      .filter((ws) => inScope(ws.output))
      .map((ws) => ({ ref: refOf(ws), layout: ws.layout, active: ws.active })),
    windows: live.flatMap((w) => {
      const ws = wsById.get(w.workspace);
      if (!ws || !inScope(w.output)) return [];
      const tiled = !w.floating && !w.fullscreen && ws.layout === "scrolling";
      const W = usable.get(w.output);
      return [
        {
          id: w.id,
          workspace: refOf(ws),
          floating: w.floating,
          fullscreen: w.fullscreen,
          extent: tiled && W ? Math.round(extentOf(w.w, W, g) * 1000) / 1000 : null,
        },
      ];
    }),
  };
}

const snapshotPath = (id: string) => join(stateDir(), "snapshots", `${id}.json`);

/**
 * Records the current layout to disk, so any Puck process (or `puck restore`) can
 * put it back. Scope it to the outputs you'll touch, so restoring doesn't undo
 * what the user changed elsewhere meanwhile.
 */
export async function saveLayout(scope?: readonly string[]): Promise<LayoutSnapshot> {
  const [snap, g] = await Promise.all([snapshot(), geometry()]);
  const saved = { ...takeSnapshot(snap, g, scope), desktop: desktopEnv().XDG_RUNTIME_DIR };
  mkdirSync(join(stateDir(), "snapshots"), { recursive: true });
  writeFileSync(snapshotPath(saved.id), JSON.stringify(saved, null, 2));
  return saved;
}

export function loadLayout(id: string): LayoutSnapshot {
  if (!/^[\w-]+$/.test(id)) throw new Error(`Invalid snapshot id ${id}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(snapshotPath(id), "utf8"));
  } catch {
    throw new Error(`No layout snapshot ${id}.`);
  }
  const parsed = LayoutSnapshotSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Snapshot ${id} is from an older Puck; take a new one.`);
  return parsed.data;
}

/**
 * Moves every window that still exists, and is still on a recorded output,
 * back to its workspace, floating, fullscreen and width; resets workspace
 * layouts; re-shows each output's workspace; and refocuses the window that had
 * focus. Windows opened since the snapshot stay where they are. Workspaces are
 * re-resolved before every move, since moving a dynamic workspace's last
 * window renumbers the others.
 */
export function restoreLayout(saved: LayoutSnapshot) {
  // Wards' desktops share output and workspace names, so a snapshot would apply to any of them.
  if (saved.desktop ? saved.desktop !== desktopEnv().XDG_RUNTIME_DIR : desktop() === "private") {
    throw new Error(`Snapshot ${saved.id} was taken on another desktop.`);
  }
  const allowed = allowedOutputs();
  const inScope = (output: string) => (!saved.scope || saved.scope.includes(output)) && (!allowed || allowed.includes(output));
  const current = async () => {
    const [all, wss] = await Promise.all([windows(), workspaces()]);
    return { live: all.filter((w) => !w.scratchpad), wss };
  };

  return withFocus(
    async (focus) => {
      const g = await geometry();
      const skipped: string[] = [];
      const placed = new Set<string>();
      let moved = 0;

      // Layouts apply to the active workspace under the cursor, so focus one of the
      // workspace's windows first (switching to an empty one is checked afterwards).
      const setLayout = async (ref: WorkspaceRef, layout: string) => {
        const { live, wss } = await current();
        if (!ref.named && ref.windows.length > 0 && !live.some((w) => ref.windows.includes(w.id))) return; // its windows are gone
        const ws = resolveRef(ref, wss, live, placed);
        if (!ws || ws.layout === layout) return;
        const member = live.find((w) => w.workspace === ws.id);
        if (member) await focus.on(member.id);
        else await focus.show(ws);
        await msg("workspace-set-layout", layout);
        if ((await workspaces()).find((w) => w.id === ws.id)?.layout !== layout) {
          skipped.push(`layout of ${describeRef(ref)} (couldn't reach it)`);
        }
      };

      // Before moving windows: an arranged workspace emptied by the moves can't be reached
      // through its windows afterwards. Dynamic workspaces that vanished are resolved later,
      // once their windows are back.
      const wsNow = await workspaces();
      const early = saved.workspaces.filter(({ ref }) => ref.named || wsNow.some((ws) => ws.id === ref.id));
      for (const { ref, layout } of early) await setLayout(ref, layout);

      for (const want of saved.windows) {
        const { live, wss } = await current();
        const w = live.find((w) => w.id === want.id);
        if (!w) continue; // closed since the snapshot
        if (!inScope(w.output)) {
          skipped.push(`${w.app_id} (now on ${w.output}, outside this snapshot)`);
          continue;
        }
        const target = resolveRef(want.workspace, wss, live, placed);
        placed.add(w.id);
        if (!target) {
          skipped.push(`${w.app_id} (${describeRef(want.workspace)} no longer exists)`);
          continue;
        }
        let touched = false;
        if (w.workspace !== target.id) {
          await focus.act(w.id, "window-move-to-workspace-silent", ...workspaceArgs(target));
          touched = true;
        }
        if (w.floating !== want.floating) {
          await msg("window-toggle-floating", w.id);
          await focus.settle();
          touched = true;
        }
        if (w.fullscreen !== want.fullscreen) {
          await focus.act(w.id, "window-toggle-fullscreen");
          touched = true;
        }
        if (touched) moved++;
      }

      for (const { ref, layout } of saved.workspaces.filter((ws) => !early.includes(ws))) await setLayout(ref, layout);

      // Widths last: layout changes reset them.
      const now = await snapshot();
      const live = now.windows.filter((w) => !w.scratchpad);
      const usable = new Map(now.outputs.map((o) => [o.name, o.usable_area.width]));
      for (const want of saved.windows) {
        const w = live.find((w) => w.id === want.id);
        const W = w && usable.get(w.output);
        if (!w || !W || want.extent === null || !inScope(w.output)) continue;
        if (w.workspace !== resolveRef(want.workspace, now.workspaces, live, placed)?.id) continue;
        if (Math.abs(extentOf(w.w, W, g) - want.extent) < 0.01) continue;
        await focus.act(w.id, "window-set-primary-extent", String(want.extent));
      }

      const end = await current();
      const visible = new Map((await outputs()).map((o) => [o.name, o.active_workspace]));
      for (const { ref } of saved.workspaces.filter((ws) => ws.active)) {
        const ws = resolveRef(ref, end.wss, end.live, placed);
        if (ws && visible.get(ws.output) !== ws.id) await focus.show(ws);
      }
      const focused = end.live.find((w) => w.id === saved.focused);
      if (focused && inScope(focused.output)) await focus.on(focused.id);
      return { moved, skipped };
    },
    { restoreFocus: saved.focused === null, shows: saved.scope ?? "all" },
  );
}
