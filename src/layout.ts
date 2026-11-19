import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "./exec.ts";
import { stateDir } from "./paths.ts";
import {
  type Snapshot,
  focusOn,
  msg,
  outputs,
  snapshot,
  withFocus,
  workspaceArgs,
} from "./umbriel.ts";

/** Everything layout_restore puts back. Column order within a workspace is not recorded. */
export type LayoutSnapshot = {
  id: string;
  createdAt: string;
  /** Outputs recorded; null for all. */
  scope: string[] | null;
  focused: string | null;
  activeWorkspaces: Record<string, string>;
  layouts: Record<string, string>;
  windows: {
    id: string;
    workspace: string;
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
  const layoutOf = new Map(snap.workspaces.map((ws) => [ws.id, ws.layout]));
  const usable = new Map(snap.outputs.map((o) => [o.name, o.usable_area.width]));
  return {
    id: randomUUID().slice(0, 8),
    createdAt: new Date().toISOString(),
    scope: scope ? [...scope] : null,
    focused: snap.focused && inScope(snap.focused.output) ? snap.focused.id : null,
    activeWorkspaces: Object.fromEntries(
      snap.outputs.flatMap((o) => (o.active_workspace && inScope(o.name) ? [[o.name, o.active_workspace]] : [])),
    ),
    layouts: Object.fromEntries(snap.workspaces.filter((ws) => inScope(ws.output)).map((ws) => [ws.id, ws.layout])),
    windows: snap.windows
      .filter((w) => !w.scratchpad && inScope(w.output))
      .map((w) => {
        const tiled = !w.floating && !w.fullscreen && layoutOf.get(w.workspace) === "scrolling";
        const W = usable.get(w.output);
        return {
          id: w.id,
          workspace: w.workspace,
          floating: w.floating,
          fullscreen: w.fullscreen,
          extent: tiled && W ? Math.round(extentOf(w.w, W, g) * 1000) / 1000 : null,
        };
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
 * snapshot stay where they are.
 */
export function restoreLayout(saved: LayoutSnapshot) {
  return withFocus(
    async () => {
      const [now, g] = await Promise.all([snapshot(), geometry()]);
      const wsById = new Map(now.workspaces.map((ws) => [ws.id, ws]));
      const current = new Map(now.windows.map((w) => [w.id, w]));
      const usable = new Map(now.outputs.map((o) => [o.name, o.usable_area.width]));
      const skipped: string[] = [];
      let moved = 0;

      for (const want of saved.windows) {
        const w = current.get(want.id);
        if (!w) continue; // closed since the snapshot
        const target = wsById.get(want.workspace);
        if (!target) {
          skipped.push(`${w.app_id} (${want.workspace} no longer exists)`);
          continue;
        }
        let touched = false;
        if (w.workspace !== want.workspace) {
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
      for (const [wsId, layout] of Object.entries(saved.layouts)) {
        const ws = wsById.get(wsId);
        if (!ws || ws.layout === layout) continue;
        await msg("workspace-switch", ...workspaceArgs(ws));
        await msg("workspace-set-layout", layout);
      }

      // Widths last: layout changes reset them.
      const after = new Map((await snapshot()).windows.map((w) => [w.id, w]));
      for (const want of saved.windows) {
        const w = after.get(want.id);
        const W = w && usable.get(w.output);
        if (!w || !W || want.extent === null || w.workspace !== want.workspace) continue;
        if (Math.abs(extentOf(w.w, W, g) - want.extent) < 0.01) continue;
        await focusOn(w.id);
        await msg("window-set-primary-extent", String(want.extent));
      }

      const visible = new Map((await outputs()).map((o) => [o.name, o.active_workspace]));
      for (const [output, wsId] of Object.entries(saved.activeWorkspaces)) {
        const ws = wsById.get(wsId);
        if (ws && visible.get(output) !== wsId) await msg("workspace-switch", ...workspaceArgs(ws));
      }
      if (saved.focused && after.has(saved.focused)) await focusOn(saved.focused);
      return { moved, skipped };
    },
    { restoreFocus: false, shows: "all" },
  );
}
