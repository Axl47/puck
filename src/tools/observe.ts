import { z } from "zod";
import { type CaptureTarget, capture, captureToFile } from "../capture.ts";
import { TEXT_MODES, inspect } from "../inspect.ts";
import { notifications, shellState } from "../noctalia.ts";
import { type Snapshot, findOutput, findWindow, snapshot } from "../umbriel.ts";
import { type Register, json } from "./common.ts";

/** The compact desktop view agents get: flags appear only when true. */
export function describeDesktop(snap: Snapshot, owned: ReadonlySet<string>) {
  const flag = (on: boolean, name: string) => (on ? { [name]: true } : {});
  return {
    focused_window: snap.focused?.id ?? null,
    outputs: snap.outputs
      .filter((o) => o.enabled)
      .map((o) => ({
        name: o.name,
        x: o.position.x,
        y: o.position.y,
        width: o.logical_size.width,
        height: o.logical_size.height,
        scale: Math.round(o.scale * 100) / 100,
        active_workspace: o.active_workspace,
        ...flag(o.focused, "focused"),
      })),
    workspaces: snap.workspaces.map((ws) => ({
      id: ws.id,
      name: ws.name,
      output: ws.output,
      layout: ws.layout,
      windows: ws.window_count,
      ...flag(ws.active, "active"),
    })),
    windows: snap.windows.map((w) => ({
      id: w.id,
      app_id: w.app_id,
      title: w.title,
      workspace: w.workspace,
      x: w.x,
      y: w.y,
      width: w.w,
      height: w.h,
      ...flag(w.visible, "visible"),
      ...flag(w.floating, "floating"),
      ...flag(w.fullscreen, "fullscreen"),
      ...flag(w.minimized, "minimized"),
      ...flag(w.urgent, "urgent"),
      ...flag(w.scratchpad !== "", "scratchpad"),
      ...flag(owned.has(w.id), "launched_by_puck"),
    })),
  };
}

export const registerObserve: Register = (server, session) => {
  server.registerTool(
    "desktop_state",
    {
      title: "Desktop state",
      description:
        "Outputs (monitors), workspaces, and every window with its id, app, title, workspace and geometry in logical pixels, plus shell settings (theme, do-not-disturb, wallpapers). Flags such as visible, floating and fullscreen appear only when true. Call this first; other tools take these ids.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const snap = await snapshot();
      // Best effort: the desktop view still works while Noctalia restarts.
      const shell = await shellState(snap.outputs.filter((o) => o.enabled).map((o) => o.name)).catch(() => null);
      return json({ ...describeDesktop(snap, session.owned), shell });
    },
  );

  server.registerTool(
    "screenshot",
    {
      title: "Screenshot",
      description:
        "Capture one output, one window (even on a hidden workspace), or a region in logical pixels. Defaults to the focused output. Returns a JPEG scaled to 1568 px on the long edge; full_res saves a PNG and returns its path instead.",
      inputSchema: {
        output: z.string().optional().describe("Output name, e.g. DP-2"),
        window_id: z.string().optional(),
        region: z
          .object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() })
          .optional()
          .describe("Global logical coordinates, as desktop_state reports them"),
        full_res: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ output, window_id, region, full_res }) => {
      if ([output, window_id, region].filter((t) => t !== undefined).length > 1) {
        throw new Error("Pass at most one of output, window_id, region.");
      }
      const snap = await snapshot();
      const maxScale = Math.max(...snap.outputs.map((o) => o.scale));
      let target: CaptureTarget;
      if (window_id) {
        const w = findWindow(snap, window_id);
        const scale = snap.outputs.find((o) => o.name === w.output)?.scale ?? maxScale;
        target = { kind: "window", id: w.id, width: w.w, height: w.h, scale };
      } else if (region) {
        target = { kind: "region", ...region, scale: maxScale };
      } else {
        const o = output ? findOutput(snap, output) : (snap.outputs.find((o) => o.focused) ?? snap.outputs[0]);
        if (!o) throw new Error("No outputs.");
        target = { kind: "output", name: o.name, width: o.logical_size.width, height: o.logical_size.height, scale: o.scale };
      }
      if (full_res) return json({ path: await captureToFile(target) });
      const shot = await capture(target);
      return {
        content: [
          { type: "image" as const, data: shot.data.toString("base64"), mimeType: shot.mimeType },
          { type: "text" as const, text: JSON.stringify({ width: shot.width, height: shot.height, target }) },
        ],
      };
    },
  );

  server.registerTool(
    "notifications",
    {
      title: "Notifications",
      description: "Recent desktop notifications, newest first. `active` ones are still on screen.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(10),
        active_only: z.boolean().default(false),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ limit, active_only }) => {
      const all = await notifications();
      return json((active_only ? all.filter((n) => n.active) : all).slice(0, limit));
    },
  );

  server.registerTool(
    "inspect",
    {
      title: "Inspect",
      description:
        "What is at a region, a window, or a point (default: under the pointer): the pointer position, the window and its process, the page URL for browsers, the accessible element under the point, and the text inside (from the app's accessibility tree when it exposes one, OCR otherwise). " +
        "A point is inspected through the window holding it. Coordinates are global logical pixels, as desktop_state reports them.",
      inputSchema: {
        region: z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() }).optional(),
        window_id: z.string().optional(),
        point: z.object({ x: z.number(), y: z.number() }).optional(),
        text: z.enum(TEXT_MODES).default("auto").describe("auto: accessibility, else OCR; none skips text"),
        screenshot: z.boolean().default(false).describe("Also save a full-resolution PNG of the target and return its path"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ region, window_id, point, text, screenshot }) => {
      if ([region, window_id, point].filter((t) => t !== undefined).length > 1) {
        throw new Error("Pass at most one of region, window_id, point.");
      }
      const target = region
        ? ({ kind: "region", rect: region } as const)
        : window_id
          ? ({ kind: "window", id: window_id } as const)
          : point
            ? ({ kind: "point", point } as const)
            : ({ kind: "pointer" } as const);
      return json(await inspect(target, { text, screenshot: screenshot || undefined }));
    },
  );
};
