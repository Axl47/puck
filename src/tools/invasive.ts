import { z } from "zod";
import { run } from "../exec.ts";
import { type KeyTarget, focusForInput, pressKeys } from "../keys.ts";
import { BUTTONS, clickOps, dragOps, movePointer, pointerInput } from "../pointer.ts";
import { findWindow, msg, snapshot, withFocus } from "../umbriel.ts";
import { type Register, assertOutputs, json } from "./common.ts";

const TYPE_CHUNK = 64;

/**
 * Closing, killing, and synthetic input. Registered only when PUCK_INVASIVE=1.
 * Close and kill refuse windows this process didn't launch unless owned_only is false.
 */
export const registerInvasive: Register = (server, session) => {
  const guardOwned = (id: string, ownedOnly: boolean) => {
    if (ownedOnly && !session.owned.has(id)) {
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
        "Ask a window to close, as its close button would (the app may prompt to save). By default only windows launched with launch_app in this session.",
      inputSchema: { window_id: z.string(), owned_only: z.boolean().default(true) },
      annotations: { destructiveHint: true },
    },
    async ({ window_id, owned_only }) => {
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
        "Force-quit a window's app process without letting it save. Last resort for a hung window. By default only windows launched with launch_app in this session, whose process owns no other windows.",
      inputSchema: { window_id: z.string(), owned_only: z.boolean().default(true) },
      annotations: { destructiveHint: true },
    },
    async ({ window_id, owned_only }) => {
      const snap = await snapshot();
      const w = findWindow(snap, window_id);
      assertOutputs(w.output);
      guardOwned(window_id, owned_only);
      // window-kill ends the whole client process, which may also own the user's windows.
      const others = snap.windows.filter((o) => o.pid === w.pid && o.id !== w.id && !session.owned.has(o.id));
      if (owned_only && others.length) {
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
    async ({ window_id, text }) =>
      withFocus(
        async (focus) => {
          const check = await focusForInput(focus, window_id);
          // In chunks (of code points, so emoji stay whole), re-checking focus between them.
          const chars = Array.from(text);
          for (let i = 0; i < chars.length; i += TYPE_CHUNK) {
            if (i > 0) await check(`${i} characters`);
            await run("wtype", ["--", chars.slice(i, i + TYPE_CHUNK).join("")], { timeoutMs: 30_000 });
          }
          await check(null);
          return json({ typed: chars.length });
        },
        { restoreFocus: true },
      ),
  );

  server.registerTool(
    "press_keys",
    {
      title: "Press keys",
      description:
        "Press key chords in order, e.g. ['ctrl+l', 'Return'], into a window (focused first, then given back) or into a shell overlay that has the keyboard. Keys are XKB names (a, Return, Escape, F5); modifiers are ctrl, shift, alt, altgr.",
      inputSchema: {
        window_id: z.string().optional(),
        overlay: overlayParam.describe(
          "Instead of window_id: the layer-shell namespace of a shell overlay that has the keyboard and should get the keys, e.g. 'selection' for slurp's picker. Refused if a different surface has the keyboard.",
        ),
        keys: z.array(z.string()).min(1).max(50),
      },
      annotations: { destructiveHint: true },
    },
    async ({ window_id, overlay, keys }) => json(await pressKeys(keyTarget(window_id, overlay), keys)),
  );

  const point = z.object({ x: z.number(), y: z.number() });
  const overlay = overlayParam.describe(
    "Layer-shell namespace of a shell overlay you mean to click into, e.g. 'selection' for slurp's picker. By default input is refused while a shell surface has the keyboard; with this, it goes ahead only if that overlay is open under every point.",
  );
  const pointerNote = " Coordinates are global logical pixels, as desktop_state reports them. Afterwards the pointer and the user's focus go back where they were.";

  server.registerTool(
    "pointer_move",
    {
      title: "Move pointer",
      description: "Move the pointer to a point and leave it there, for hover effects. Focus follows it if the desktop is set to focus follows mouse.",
      inputSchema: point.shape,
      annotations: { destructiveHint: false },
    },
    async (p) => json({ moved_to: await movePointer(p) }),
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
        overlay,
      },
      annotations: { destructiveHint: true },
    },
    async ({ x, y, button, count, overlay }) => json(await pointerInput(pointOrNull(x, y), () => clickOps(button, count), { overlay })),
  );

  server.registerTool(
    "drag",
    {
      title: "Drag",
      description: "Press at one point, move to another, and release." + pointerNote,
      inputSchema: { from: point, to: point, button: z.enum(BUTTONS).default("left"), overlay },
      annotations: { destructiveHint: true },
    },
    async ({ from, to, button, overlay }) => json(await pointerInput(from, (outs) => dragOps(outs, from, to, button), { overlay })),
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
        overlay,
      },
      annotations: { destructiveHint: true },
    },
    async ({ x, y, dx, dy, overlay }) => json(await pointerInput(pointOrNull(x, y), () => [{ op: "scroll", dx, dy }], { overlay })),
  );
};

const overlayParam = z.string().min(1).optional();

/** A key target from press_keys' parameters: exactly one of a window and an overlay. */
function keyTarget(windowId: string | undefined, overlay: string | undefined): KeyTarget {
  if (windowId !== undefined && overlay === undefined) return { window: windowId };
  if (overlay !== undefined && windowId === undefined) return { overlay };
  throw new Error("Pass exactly one of window_id and overlay.");
}

/** A point from optional coordinates: both or neither. */
function pointOrNull(x: number | undefined, y: number | undefined) {
  if ((x === undefined) !== (y === undefined)) throw new Error("Pass both x and y, or neither to use the pointer's position.");
  return x === undefined || y === undefined ? null : { x, y };
}
