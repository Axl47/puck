import { z } from "zod";
import { desktop } from "../exec.ts";
import { keyTarget, pressKeys, typeText } from "../keys.ts";
import { BUTTONS, clickOps, dragOps, fromWindow, movePointer, pointerInput } from "../pointer.ts";
import { findWindow, msg, snapshot } from "../umbriel.ts";
import { type Register, assertOutputs, json } from "./common.ts";

/**
 * Closing, killing, and synthetic input. On a private desktop, where everything
 * is the agent's own, they just work. On the live session they need
 * PUCK_INVASIVE=1, and close and kill refuse windows this process didn't launch
 * unless owned_only is false.
 */
export const registerInvasive: Register = (server, session) => {
  const live = () => desktop() === "live";
  const allowed = () => {
    if (live() && process.env.PUCK_INVASIVE !== "1") {
      throw new Error(
        "Refused on the user's live session, where this needs PUCK_INVASIVE=1 in the server's environment. On your private desktop it is always allowed: `puck open CMD` in a shell opens something there. If you did that and desktop_state still says live, this server can't tell which thread it serves; use the `puck` CLI in your shell instead (`puck state`, `puck pointer click`, `puck keys`).",
      );
    }
  };
  const guardOwned = (id: string, ownedOnly: boolean) => {
    if (live() && ownedOnly && !session.owned.has(id)) {
      throw new Error(
        "Refusing: Puck didn't launch this window in this session. Pass owned_only: false only if the user asked for this specific window to go.",
      );
    }
  };

  server.registerTool(
    "close_window",
    {
      title: "Close window",
      description:
        "Ask a window to close, as its close button would (the app may prompt to save). On the live session, by default only windows launched with launch_app in this session.",
      inputSchema: { window_id: z.string(), owned_only: z.boolean().default(true) },
      annotations: { destructiveHint: true },
    },
    async ({ window_id, owned_only }) => {
      allowed();
      assertOutputs(findWindow(await snapshot(), window_id).output);
      guardOwned(window_id, owned_only);
      await msg("window-close", window_id);
      session.owned.delete(window_id);
      return json({ closed: window_id });
    },
  );

  server.registerTool(
    "kill_window",
    {
      title: "Kill window",
      description:
        "Force-quit a window's app process without letting it save. Last resort for a hung window. On the live session, by default only windows launched with launch_app in this session, whose process owns no other windows.",
      inputSchema: { window_id: z.string(), owned_only: z.boolean().default(true) },
      annotations: { destructiveHint: true },
    },
    async ({ window_id, owned_only }) => {
      allowed();
      const snap = await snapshot();
      const w = findWindow(snap, window_id);
      assertOutputs(w.output);
      guardOwned(window_id, owned_only);
      // window-kill ends the whole client process, which may also own the user's windows.
      const others = snap.windows.filter((o) => o.pid === w.pid && o.id !== w.id && !session.owned.has(o.id));
      if (live() && owned_only && others.length) {
        throw new Error(
          `Refusing: this window's process also owns ${others.length} window(s) Puck didn't launch, and killing it would close them too. Use close_window.`,
        );
      }
      await msg("window-kill", window_id);
      session.owned.delete(window_id);
      return json({ killed: window_id });
    },
  );

  server.registerTool(
    "type_text",
    {
      title: "Type text",
      description: "Focus a window and type text into it as keyboard input. Focus returns to the user's window afterwards.",
      inputSchema: { window_id: z.string(), text: z.string().min(1).max(10_000) },
      annotations: { destructiveHint: true },
    },
    async ({ window_id, text }) => {
      allowed();
      return json(await typeText(window_id, text));
    },
  );

  server.registerTool(
    "press_keys",
    {
      title: "Press keys",
      description:
        "Press key chords in order, e.g. ['ctrl+l', 'Return'], into a window (focused first, then given back; the focused window if neither window_id nor overlay is given) or into a shell overlay that has the keyboard. Keys are XKB names (a, Return, Escape, F5); modifiers are ctrl, shift, alt, altgr. On a private desktop, shortcuts don't act in GTK 3 apps (text does, and GTK 4 apps and terminals take both): click the control instead.",
      inputSchema: {
        window_id: z.string().optional(),
        overlay: overlayParam.describe(
          "Instead of window_id: the layer-shell namespace of a shell overlay that has the keyboard and should get the keys, e.g. 'selection' for slurp's picker. Refused if a different surface has the keyboard.",
        ),
        keys: z.array(z.string()).min(1).max(50),
      },
      annotations: { destructiveHint: true },
    },
    async ({ window_id, overlay, keys }) => {
      allowed();
      return json(await pressKeys(await keyTarget(window_id, overlay), keys));
    },
  );

  const point = z.object({ x: z.number(), y: z.number() });
  const overlay = overlayParam.describe(
    "Layer-shell namespace of a shell overlay you mean to click into, e.g. 'selection' for slurp's picker. By default input is refused while a shell surface has the keyboard; with this, it goes ahead only if that overlay is open under every point.",
  );
  const window_id = z
    .string()
    .optional()
    .describe("Count the coordinates from this window's top-left corner instead of globally. On a private desktop those are the pixels of a screenshot of the window, and a window that isn't showing is focused first; where a screenshot was scaled (the sizes it returns differ), convert to the window's logical size first.");
  const pointerNote = " Coordinates are logical pixels: global, as desktop_state reports them, or with window_id from that window's top-left corner. Afterwards the pointer and the user's focus go back where they were.";

  server.registerTool(
    "pointer_move",
    {
      title: "Move pointer",
      description: "Move the pointer to a point and leave it there, for hover effects. Focus follows it if the desktop is set to focus follows mouse.",
      inputSchema: { ...point.shape, window_id },
      annotations: { destructiveHint: false },
    },
    async ({ window_id, ...p }) => {
      allowed();
      const { points, still } = await fromWindow(window_id, [p]);
      return json({ moved_to: await movePointer(points[0], still) });
    },
  );

  server.registerTool(
    "click",
    {
      title: "Click",
      description: "Click at a point (default: where the pointer is). count 2 double-clicks." + pointerNote,
      inputSchema: {
        x: z.number().optional(),
        y: z.number().optional(),
        button: z.enum(BUTTONS).default("left"),
        count: z.number().int().min(1).max(3).default(1),
        window_id,
        overlay,
      },
      annotations: { destructiveHint: true },
    },
    async ({ x, y, button, count, window_id, overlay }) => {
      allowed();
      const { at, still } = await pointIn(window_id, x, y);
      return json(await pointerInput(at, () => clickOps(button, count), { overlay, still }));
    },
  );

  server.registerTool(
    "drag",
    {
      title: "Drag",
      description: "Press at one point, move to another, and release." + pointerNote,
      inputSchema: { from: point, to: point, button: z.enum(BUTTONS).default("left"), window_id, overlay },
      annotations: { destructiveHint: true },
    },
    async ({ from: a, to: b, button, window_id, overlay }) => {
      allowed();
      const { points, still } = await fromWindow(window_id, [a, b]);
      const [from, to] = points;
      return json(await pointerInput(from, (outs) => dragOps(outs, from, to, button), { overlay, still }));
    },
  );

  server.registerTool(
    "scroll",
    {
      title: "Scroll",
      description: "Turn the scroll wheel at a point (default: where the pointer is). dy > 0 scrolls down, dx > 0 right, in wheel steps." + pointerNote,
      inputSchema: {
        x: z.number().optional(),
        y: z.number().optional(),
        dx: z.number().int().min(-50).max(50).default(0),
        dy: z.number().int().min(-50).max(50).default(0),
        window_id,
        overlay,
      },
      annotations: { destructiveHint: true },
    },
    async ({ x, y, dx, dy, window_id, overlay }) => {
      allowed();
      const { at, still } = await pointIn(window_id, x, y);
      return json(await pointerInput(at, () => [{ op: "scroll", dx, dy }], { overlay, still }));
    },
  );
};

const overlayParam = z.string().min(1).optional();

/** A global point from optional coordinates (both or neither), counted from a window when one is given, with fromWindow's check. */
async function pointIn(windowId: string | undefined, x: number | undefined, y: number | undefined) {
  if ((x === undefined) !== (y === undefined)) throw new Error("Pass both x and y, or neither to use the pointer's position.");
  if (x === undefined || y === undefined) {
    if (windowId !== undefined) throw new Error("window_id needs x and y.");
    return { at: null, still: undefined };
  }
  const { points, still } = await fromWindow(windowId, [{ x, y }]);
  return { at: points[0], still };
}
