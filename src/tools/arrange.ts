import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { commandLine, desktopEntries, resolveApp, windowHints } from "../apps.ts";
import { ARRANGEMENTS, pickWorkspace } from "../arrange.ts";
import { sleep } from "../exec.ts";
import { loadLayout, restoreLayout, saveLayout } from "../layout.ts";
import {
  clearActiveNotifications,
  dismissNotification,
  setDoNotDisturb,
  setThemeMode,
  setWallpaper,
  shellState,
} from "../noctalia.ts";
import {
  LAYOUTS,
  type Window,
  findOutput,
  findWindow,
  findWorkspace,
  msg,
  outputs,
  snapshot,
  windows,
  withFocus,
  workspaceArgs,
  workspaces,
} from "../umbriel.ts";
import { type Register, allowedOutputs, assertOutputs, assertShell, assertUnrestricted, json } from "./common.ts";

const reversible = { readOnlyHint: false, destructiveHint: false } as const;
/** Changes nothing can undo exactly (a dismissed notification, a replaced setting). */
const lasting = { readOnlyHint: false, destructiveHint: true } as const;

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
        async (focus) => {
          assertOutputs(findWindow(await snapshot(), window_id).output);
          await focus.on(window_id);
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
        async (focus) => {
          const snap = await snapshot();
          const w = findWindow(snap, window_id);
          const target = workspace
            ? findWorkspace(snap, workspace)
            : output
              ? findWorkspace(snap, findOutput(snap, output).active_workspace ?? "")
              : undefined;
          assertOutputs(w.output, ...(target ? [target.output] : []));
          if (target && target.id !== w.workspace) {
            await focus.act(w.id, "window-move-to-workspace-silent", ...workspaceArgs(target));
          }
          if (floating !== undefined && floating !== w.floating) {
            await msg("window-toggle-floating", w.id);
            await focus.settle();
          }
          if (fullscreen !== undefined && fullscreen !== w.fullscreen) await focus.act(w.id, "window-toggle-fullscreen");
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
        async (focus) => {
          const snap = await snapshot();
          findOutput(snap, output);
          const wins = window_ids.map((id) => findWindow(snap, id));
          assertOutputs(output, ...wins.map((w) => w.output));
          const target = workspace ? findWorkspace(snap, workspace) : pickWorkspace(snap, output, window_ids);
          if (target.output !== output) throw new Error(`${target.id} is not on ${output}.`);

          // Move in order so tiling order follows window_ids.
          for (const w of wins) {
            if (w.workspace !== target.id) await focus.act(w.id, "window-move-to-workspace-silent", ...workspaceArgs(target));
            if (w.floating) {
              await msg("window-toggle-floating", w.id);
              await focus.settle();
            }
          }
          // Focusing a window on the target shows it and puts the cursor there, where set-layout applies.
          await focus.act((wins[0] as Window).id, "workspace-set-layout", ARRANGEMENTS[layout]);
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
        async (focus) => {
          const snap = await snapshot();
          const ws = findWorkspace(snap, workspace);
          assertOutputs(ws.output);
          await focus.show(ws);
          if (layout) {
            // set-layout applies under the cursor; focusing one of the workspace's windows puts it there.
            const member = snap.windows.find((w) => w.workspace === ws.id && !w.scratchpad);
            if (member) await focus.on(member.id);
            await msg("workspace-set-layout", layout);
          }
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
        "Start an installed app by name or desktop id (e.g. 'Obsidian', 'helium') and wait for its window. Opens on `workspace` or `output` when given, else the focused output. Apps with their own window rules may open elsewhere. Returns the new window; focus stays with the user (use focus_window if the task needs it). It opens on your private desktop, started if needed; only after desktop_state with desktop \"live\" does it open on the user's screen. For a command that isn't an installed app (a dev build, a URL in a browser), `puck open CMD` in a shell.",
      inputSchema: {
        app: z.string(),
        workspace: z.string().optional().describe("Workspace id to open on; switches that output to it"),
        output: z.string().optional().describe("Output to open on, at its active workspace"),
      },
      annotations: { ...reversible, openWorldHint: true },
    },
    async ({ app, workspace, output }) => {
      const entry = resolveApp(app, desktopEntries());
      if (entry.terminal) throw new Error(`${entry.name} runs in a terminal; launch_app starts graphical apps only.`);
      const snap = await snapshot();
      const target = workspace
        ? findWorkspace(snap, workspace)
        : output
          ? findWorkspace(snap, findOutput(snap, output).active_workspace ?? "")
          : undefined;
      const allowed = allowedOutputs();
      if (allowed && !target) throw new Error(`Pass output or workspace (PUCK_OUTPUTS limits Puck to ${allowed.join(", ")}).`);
      if (target) assertOutputs(target.output);

      // Only a new window of this app counts (or, with a target, a new window there, for
      // wrapper scripts), so nothing the user opens elsewhere meanwhile is claimed.
      const before = new Set(snap.windows.map((w) => w.id));
      const hints = windowHints(entry);
      const isNew = (w: Window) => {
        const a = w.app_id.toLowerCase();
        const named = a !== "" && hints.some((h) => a.includes(h) || h.includes(a));
        return !before.has(w.id) && (named || w.workspace === target?.id);
      };
      const waitForWindow = async () => {
        for (let waited = 0; waited < 15_000; waited += 250) {
          await sleep(250);
          const w = (await windows()).find(isNew);
          if (w) return w;
        }
        return null;
      };

      // New windows open on the focused output, so a target keeps focus there until the window maps.
      const w = target
        ? await withFocus(
            async (focus) => {
              await focus.show(target);
              await msg("spawn", commandLine(entry));
              const w = await waitForWindow();
              await focus.settle();
              if (!w) return null;
              // A window rule may have sent it elsewhere; under PUCK_OUTPUTS, bring it back and
              // leave that output showing what it showed.
              if (allowed && !allowed.includes(w.output)) {
                const shown = (await outputs()).find((o) => o.name === w.output)?.active_workspace;
                await focus.act(w.id, "window-move-to-workspace-silent", ...workspaceArgs(target));
                const ws = (await workspaces()).find((ws) => ws.id === shown);
                if (ws && (await outputs()).find((o) => o.name === ws.output)?.active_workspace !== ws.id) {
                  await msg("workspace-switch", ...workspaceArgs(ws));
                }
                await focus.on(w.id);
              }
              return w;
            },
            { restoreFocus: true, shows: [target.output] },
          )
        : await msg("spawn", commandLine(entry)).then(waitForWindow);

      if (!w) {
        return json({
          app: entry.name,
          window: null,
          note: "No new window within 15 s. Single-instance apps may have reused an existing window; check desktop_state.",
        });
      }
      session.owned.add(w.id);
      return json({ app: entry.name, window: (await placement([w.id]))[0] });
    },
  );

  server.registerTool(
    "layout_snapshot",
    {
      title: "Save layout",
      description:
        "Record each window's workspace, floating/fullscreen state and width, each workspace's layout, the visible workspaces and focus. Take one before rearranging and restore it when done, to leave the desktop as you found it. Pass the outputs you'll touch so a restore can't undo changes the user makes elsewhere meanwhile.",
      inputSchema: { outputs: z.array(z.string()).optional().describe("Output names to record; all when omitted") },
      annotations: { ...reversible, readOnlyHint: true },
    },
    async ({ outputs }) => {
      const scope = outputs ?? allowedOutputs() ?? undefined;
      if (scope) assertOutputs(...scope);
      const saved = await saveLayout(scope);
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
    async ({ snapshot_id }) => {
      const saved = loadLayout(snapshot_id);
      if (allowedOutputs()) {
        if (!saved.scope) throw new Error("This snapshot covers every output; disabled while PUCK_OUTPUTS is set.");
        assertOutputs(...saved.scope);
      }
      return json(await restoreLayout(saved));
    },
  );

  server.registerTool(
    "dismiss_notification",
    {
      title: "Dismiss notification",
      description: "Close one notification by id (from `notifications`), or every notification on screen with all: true.",
      inputSchema: { id: z.number().int().optional(), all: z.boolean().optional() },
      annotations: lasting,
    },
    async ({ id, all }) => {
      assertShell("Notifications");
      assertUnrestricted("Dismissing notifications");
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
        "Change Noctalia settings: wallpaper (all outputs, or one), theme mode, do-not-disturb. These persist; the result includes the previous values so you can put them back.",
      inputSchema: {
        wallpaper: z.object({ path: z.string().describe("Absolute path to an image"), output: z.string().optional() }).optional(),
        theme_mode: z.enum(["dark", "light", "auto"]).optional(),
        do_not_disturb: z.boolean().optional(),
      },
      annotations: lasting,
    },
    async ({ wallpaper, theme_mode, do_not_disturb }) => {
      assertShell("Shell settings");
      assertUnrestricted("Changing shell settings");
      if (wallpaper && !(isAbsolute(wallpaper.path) && statSync(wallpaper.path, { throwIfNoEntry: false })?.isFile())) {
        throw new Error(`No image file at ${wallpaper.path} (the path must be absolute).`);
      }
      const snap = await snapshot();
      const previous = await shellState(snap.outputs.filter((o) => o.enabled).map((o) => o.name));
      if (wallpaper) await setWallpaper(wallpaper.path, wallpaper.output);
      if (theme_mode) await setThemeMode(theme_mode);
      if (do_not_disturb !== undefined) await setDoNotDisturb(do_not_disturb);
      return json({ changed: { wallpaper, theme_mode, do_not_disturb }, previous });
    },
  );
};
