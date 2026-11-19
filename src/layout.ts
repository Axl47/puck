import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "./exec.ts";
import { stateDir } from "./paths.ts";
import {
  type Snapshot,
  type Workspace,
  focusOn,
  msg,
  outputs,
  snapshot,
  windows,
  withFocus,
  workspaceArgs,
  workspaces,
} from "./umbriel.ts";

/**
 * How a snapshot names a workspace. Ids aren't stable: unnamed (dynamic)
 * workspaces vanish when empty and the rest renumber. So named workspaces are
 * found by name, dynamic ones by position on their output.
 */
export type WorkspaceRef = { output: string; name: string; named: boolean; index: number };

const refOf = (ws: Workspace): WorkspaceRef => ({ output: ws.output, name: ws.name, named: ws.named, index: ws.index });

export function resolveRef(ref: WorkspaceRef, all: readonly Workspace[]): Workspace | undefined {
  return all.find(
    (ws) => ws.output === ref.output && ws.named === ref.named && (ref.named ? ws.name === ref.name : ws.index === ref.index),
  );
}

const describeRef = (ref: WorkspaceRef) => (ref.named ? `${ref.output} ${ref.name}` : `${ref.output} workspace ${ref.index}`);

/** Everything layout_restore puts back. Column order within a workspace is not recorded. */
export type LayoutSnapshot = {
  id: string;
  createdAt: string;
  /** Outputs recorded; null for all. */
  scope: string[] | null;
  focused: string | null;
  /** Workspaces that were visible or held windows. */
  workspaces: { ref: WorkspaceRef; layout: string; active: boolean }[];
  windows: {
    id: string;
    workspace: WorkspaceRef;
    floating: boolean;
    fullscreen: boolean;
    /** Column width as a fraction of the output, for tiled windows on scrolling workspaces. */
    extent: number | null;
  }[];
};

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
  const wsById = new Map(snap.workspaces.map((ws) => [ws.id, ws]));
  const usable = new Map(snap.outputs.map((o) => [o.name, o.usable_area.width]));
  return {
    id: randomUUID().slice(0, 8),
    createdAt: new Date().toISOString(),
    scope: scope ? [...scope] : null,
    focused: snap.focused && inScope(snap.focused.output) ? snap.focused.id : null,
    workspaces: snap.workspaces
      .filter((ws) => inScope(ws.output) && (ws.active || ws.window_count > 0))
      .map((ws) => ({ ref: refOf(ws), layout: ws.layout, active: ws.active })),
    windows: snap.windows.flatMap((w) => {
      const ws = wsById.get(w.workspace);
      if (w.scratchpad || !ws || !inScope(w.output)) return [];
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
  const saved = takeSnapshot(snap, g, scope);
  mkdirSync(join(stateDir(), "snapshots"), { recursive: true });
  writeFileSync(snapshotPath(saved.id), JSON.stringify(saved, null, 2));
  return saved;
}

export function loadLayout(id: string): LayoutSnapshot {
  if (!/^[\w-]+$/.test(id)) throw new Error(`Invalid snapshot id ${id}`);
  try {
    return JSON.parse(readFileSync(snapshotPath(id), "utf8")) as LayoutSnapshot;
  } catch {
    throw new Error(`No layout snapshot ${id}.`);
  }
}

/**
 * Moves every window that still exists back to its recorded workspace, floating,
 * fullscreen and width; resets workspace layouts; re-activates each output's
 * workspace; and refocuses the window that had focus. Windows opened since the
 * snapshot stay where they are. Workspaces are re-resolved before every move,
 * since moving a dynamic workspace's last window renumbers the others.
 */
export function restoreLayout(saved: LayoutSnapshot) {
  return withFocus(
    async () => {
      const g = await geometry();
      const skipped: string[] = [];
      let moved = 0;

      for (const want of saved.windows) {
        const [all, wss] = await Promise.all([windows(), workspaces()]);
        const w = all.find((w) => w.id === want.id);
        if (!w) continue; // closed since the snapshot
        const target = resolveRef(want.workspace, wss);
        if (!target) {
          skipped.push(`${w.app_id} (${describeRef(want.workspace)} no longer exists)`);
          continue;
        }
        let touched = false;
        if (w.workspace !== target.id) {
          await focusOn(w.id);
          await msg("window-move-to-workspace-silent", ...workspaceArgs(target));
          touched = true;
        }
        if (w.floating !== want.floating) {
          await msg("window-toggle-floating", w.id);
          touched = true;
        }
        if (w.fullscreen !== want.fullscreen) {
          await focusOn(w.id);
          await msg("window-toggle-fullscreen");
          touched = true;
        }
        if (touched) moved++;
      }

      // Layouts can only be set on the active workspace of the focused output.
      for (const { ref, layout } of saved.workspaces) {
        const ws = resolveRef(ref, await workspaces());
        if (!ws || ws.layout === layout) continue;
        await msg("workspace-switch", ...workspaceArgs(ws));
        await msg("workspace-set-layout", layout);
      }

      // Widths last: layout changes reset them.
      const now = await snapshot();
      const usable = new Map(now.outputs.map((o) => [o.name, o.usable_area.width]));
      for (const want of saved.windows) {
        const w = now.windows.find((w) => w.id === want.id);
        const W = w && usable.get(w.output);
        if (!w || !W || want.extent === null || w.workspace !== resolveRef(want.workspace, now.workspaces)?.id) continue;
        if (Math.abs(extentOf(w.w, W, g) - want.extent) < 0.01) continue;
        await focusOn(w.id);
        await msg("window-set-primary-extent", String(want.extent));
      }

      const visible = new Map((await outputs()).map((o) => [o.name, o.active_workspace]));
      for (const { ref } of saved.workspaces.filter((ws) => ws.active)) {
        const ws = resolveRef(ref, now.workspaces);
        if (ws && visible.get(ws.output) !== ws.id) await msg("workspace-switch", ...workspaceArgs(ws));
      }
      if (saved.focused && now.windows.some((w) => w.id === saved.focused)) await focusOn(saved.focused);
      return { moved, skipped };
    },
    { restoreFocus: false, shows: "all" },
  );
}
