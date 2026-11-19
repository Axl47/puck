import { statSync } from "node:fs";
import { z } from "zod";
import { commandLine, desktopEntries, resolveApp } from "../apps.ts";
import { ARRANGEMENTS, pickWorkspace } from "../arrange.ts";
import { sleep } from "../exec.ts";
import { loadLayout, restoreLayout, saveLayout } from "../layout.ts";
import { clearActiveNotifications, dismissNotification, setDoNotDisturb, setThemeMode, setWallpaper } from "../noctalia.ts";
import {
  LAYOUTS,
  type Window,
  findOutput,
  findWindow,
  findWorkspace,
  focusOn,
  msg,
  snapshot,
  windows,
  withFocus,
  workspaceArgs,
} from "../umbriel.ts";
import { type Register, json } from "./common.ts";

const reversible = { readOnlyHint: false, destructiveHint: false } as const;

/** Where a set of windows ended up, for tool results. */
async function placement(ids: readonly string[]) {
  const all = await windows();
  return ids.flatMap((id) => {
    const w = all.find((w) => w.id === id);
    return w ? [{ id, app_id: w.app_id, workspace: w.workspace, x: w.x, y: w.y, width: w.w, height: w.h, visible: w.visible }] : [];
  });
}

export const registerArrange: Register = (server, session) => {
  server.registerTool(
    "focus_window",
    {
      title: "Focus window",
      description: "Give a window keyboard focus, switching to its workspace and moving the cursor onto it.",
      inputSchema: { window_id: z.string() },
      annotations: reversible,
    },
    async ({ window_id }) =>
      withFocus(
        async () => {
          findWindow(await snapshot(), window_id);
          await focusOn(window_id);
          return json(await placement([window_id]));
        },
        { restoreFocus: false, shows: "all" },
      ),
  );

  server.registerTool(
    "move_window",
    {
      title: "Move window",
      description:
        "Move a window to a workspace (by id) or to an output's active workspace, and/or set floating or fullscreen. Doesn't switch the visible workspace.",
      inputSchema: {
        window_id: z.string(),
        workspace: z.string().optional().describe("Workspace id from desktop_state, e.g. DP-2:8"),
        output: z.string().optional().describe("Move to this output's active workspace"),
        floating: z.boolean().optional(),
        fullscreen: z.boolean().optional(),
      },
      annotations: reversible,
    },
    async ({ window_id, workspace, output, floating, fullscreen }) =>
      withFocus(
        async () => {
          const snap = await snapshot();
          const w = findWindow(snap, window_id);
          const target = workspace
            ? findWorkspace(snap, workspace)
            : output
              ? findWorkspace(snap, findOutput(snap, output).active_workspace ?? "")
              : undefined;
          if (target && target.id !== w.workspace) {
            await focusOn(w.id);
            await msg("window-move-to-workspace-silent", ...workspaceArgs(target));
          }
          if (floating !== undefined && floating !== w.floating) await msg("window-toggle-floating", w.id);
          if (fullscreen !== undefined && fullscreen !== w.fullscreen) {
            await focusOn(w.id);
            await msg("window-toggle-fullscreen");
          }
          await sleep(150);
          return json(await placement([w.id]));
        },
        { restoreFocus: true },
      ),
  );

  server.registerTool(
    "arrange_windows",
    {
      title: "Arrange windows",
      description:
        "Tile 1-4 windows together on one output and show them. `split` puts two side by side (more get recursive halves); `master` makes the first large with the rest stacked. Uses a workspace on that output with no other windows, unless `workspace` names one.",
      inputSchema: {
        window_ids: z.array(z.string()).min(1).max(4).describe("In order: first is left / master"),
        output: z.string(),
        layout: z.enum(["split", "master"]).default("split"),
        workspace: z.string().optional().describe("Workspace id on that output to use instead"),
      },
      annotations: reversible,
    },
    async ({ window_ids, output, layout, workspace }) =>
      withFocus(
        async () => {
          const snap = await snapshot();
          findOutput(snap, output);
          const wins = window_ids.map((id) => findWindow(snap, id));
          const target = workspace ? findWorkspace(snap, workspace) : pickWorkspace(snap, output, window_ids);
          if (target.output !== output) throw new Error(`${target.id} is not on ${output}.`);

          // Move in order so tiling order follows window_ids.
          for (const w of wins) {
            if (w.workspace === target.id && !w.floating) continue;
            await focusOn(w.id);
            if (w.workspace !== target.id) await msg("window-move-to-workspace-silent", ...workspaceArgs(target));
            if (w.floating) await msg("window-toggle-floating", w.id);
          }
          await msg("workspace-switch", ...workspaceArgs(target));
          const first = wins[0] as Window;
          await focusOn(first.id);
          await msg("workspace-set-layout", ARRANGEMENTS[layout]);
          await sleep(300); // let the layout animation settle before reporting geometry
          return json({ workspace: target.id, windows: await placement(window_ids) });
        },
        { restoreFocus: true, shows: [output] },
      ),
  );

  server.registerTool(
    "switch_workspace",
    {
      title: "Switch workspace",
      description: "Show a workspace on its output, optionally changing its layout.",
      inputSchema: {
        workspace: z.string().describe("Workspace id, e.g. DP-2:8"),
        layout: z.enum(LAYOUTS).optional(),
      },
      annotations: reversible,
    },
    async ({ workspace, layout }) =>
      withFocus(
        async () => {
          const ws = findWorkspace(await snapshot(), workspace);
          await msg("workspace-switch", ...workspaceArgs(ws));
          if (layout) await msg("workspace-set-layout", layout);
          return json({ workspace: ws.id, layout: layout ?? ws.layout });
        },
        { restoreFocus: true, shows: "all" },
      ),
  );

  server.registerTool(
    "launch_app",
    {
      title: "Launch app",
      description:
        "Start an installed app by name or desktop id (e.g. 'Zed', 'helium') and wait for its window. Opens on `workspace` or `output` when given, else the focused output. Apps with their own window rules may open elsewhere. Returns the new window.",
      inputSchema: {
        app: z.string(),
        workspace: z.string().optional().describe("Workspace id to open on; switches that output to it"),
        output: z.string().optional().describe("Output to open on, at its active workspace"),
      },
      annotations: { ...reversible, openWorldHint: true },
    },
    async ({ app, workspace, output }) =>
      withFocus(
        async () => {
          const entry = resolveApp(app, desktopEntries());
          const snap = await snapshot();
          const target = workspace
            ? findWorkspace(snap, workspace)
            : output
              ? findWorkspace(snap, findOutput(snap, output).active_workspace ?? "")
              : undefined;
          if (target) await msg("workspace-switch", ...workspaceArgs(target));

          const before = new Set(snap.windows.map((w) => w.id));
          await msg("spawn", commandLine(entry));
          for (let waited = 0; waited < 15_000; waited += 250) {
            await sleep(250);
            const fresh = (await windows()).filter((w) => !before.has(w.id));
            if (fresh.length === 0) continue;
            const hint = (entry.wmClass ?? entry.id).toLowerCase();
            const w = fresh.find((w) => w.app_id.toLowerCase().includes(hint) || hint.includes(w.app_id.toLowerCase())) ?? fresh[0];
            if (!w) continue;
            session.owned.add(w.id);
            return json({ app: entry.name, window: (await placement([w.id]))[0] });
          }
          return json({
            app: entry.name,
            window: null,
            note: "No new window within 15 s. Single-instance apps may have reused an existing window; check desktop_state.",
          });
        },
        { restoreFocus: false, shows: "all" },
      ),
  );

  server.registerTool(
    "layout_snapshot",
    {
      title: "Save layout",
      description:
        "Record every window's workspace, floating/fullscreen state and width, each workspace's layout, the visible workspaces and focus. Take one before rearranging and restore it when done, to leave the desktop as you found it.",
      annotations: { ...reversible, readOnlyHint: true },
    },
    async () => {
      const saved = await saveLayout();
      return json({ snapshot_id: saved.id, windows: saved.windows.length });
    },
  );

  server.registerTool(
    "layout_restore",
    {
      title: "Restore layout",
      description:
        "Put windows, workspace layouts, visible workspaces and focus back as a layout_snapshot recorded them. Windows opened since stay where they are; order within a workspace isn't restored.",
      inputSchema: { snapshot_id: z.string() },
      annotations: reversible,
    },
    async ({ snapshot_id }) => json(await restoreLayout(loadLayout(snapshot_id))),
  );

  server.registerTool(
    "dismiss_notification",
    {
      title: "Dismiss notification",
      description: "Close one notification by id (from `notifications`), or every notification on screen with all: true.",
      inputSchema: { id: z.number().int().optional(), all: z.boolean().optional() },
      annotations: reversible,
    },
    async ({ id, all }) => {
      if (all) await clearActiveNotifications();
      else if (id !== undefined) await dismissNotification(id);
      else throw new Error("Pass id or all: true.");
      return json({ dismissed: all ? "all" : id });
    },
  );

  server.registerTool(
    "shell_settings",
    {
      title: "Shell settings",
      description:
        "Change Noctalia settings: wallpaper (all outputs, or one), theme mode, do-not-disturb. These persist. Read current values from desktop_state first if you mean to put them back.",
      inputSchema: {
        wallpaper: z.object({ path: z.string(), output: z.string().optional() }).optional(),
        theme_mode: z.enum(["dark", "light", "auto"]).optional(),
        do_not_disturb: z.boolean().optional(),
      },
      annotations: reversible,
    },
    async ({ wallpaper, theme_mode, do_not_disturb }) => {
      if (wallpaper) {
        if (!statSync(wallpaper.path, { throwIfNoEntry: false })?.isFile()) {
          throw new Error(`No image file at ${wallpaper.path}.`);
        }
        await setWallpaper(wallpaper.path, wallpaper.output);
      }
      if (theme_mode) await setThemeMode(theme_mode);
      if (do_not_disturb !== undefined) await setDoNotDisturb(do_not_disturb);
      return json({ changed: { wallpaper, theme_mode, do_not_disturb } });
    },
  );
};
