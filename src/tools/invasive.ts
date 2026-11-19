import { z } from "zod";
import { run } from "../exec.ts";
import { BUTTONS, clickOps, dragOps, movePointer, pointerInput } from "../pointer.ts";
import { type Focus, type Window, findWindow, focusedWindow, keyboardGrab, msg, outputs, snapshot, withFocus } from "../umbriel.ts";
import { type Register, assertOutputs, json } from "./common.ts";

const MODIFIERS: Record<string, string> = {
  ctrl: "ctrl",
  control: "ctrl",
  shift: "shift",
  alt: "alt",
  altgr: "altgr",
};

/** Super chords and taps are compositor keybinds (close window, lock, launcher), not app input. */
const COMPOSITOR_MODIFIERS = new Set(["super", "meta", "logo", "win", "mod"]);
const COMPOSITOR_KEY = /^(super|meta|hyper)(_[lr])?$/i;

const KEY_ALIASES: Record<string, string> = {
  enter: "Return",
  return: "Return",
  esc: "Escape",
  escape: "Escape",
  tab: "Tab",
  space: "space",
  backspace: "BackSpace",
  delete: "Delete",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
  pageup: "Prior",
  pagedown: "Next",
};

/** wtype arguments for one chord like `ctrl+shift+t` or `Return`. */
export function chordArgs(chord: string): string[] {
  const parts = chord.split("+").map((p) => p.trim()).filter(Boolean);
  const key = parts.pop();
  if (!key) throw new Error(`Empty key chord "${chord}".`);
  if (COMPOSITOR_KEY.test(key)) {
    throw new Error(`"${chord}" would trigger a desktop shortcut, not reach the app; Puck doesn't send super keys.`);
  }
  const mods = parts.map((p) => {
    if (COMPOSITOR_MODIFIERS.has(p.toLowerCase())) {
      throw new Error(`"${chord}" would trigger a desktop shortcut, not reach the app; Puck doesn't send super chords.`);
    }
    const m = MODIFIERS[p.toLowerCase()];
    if (!m) throw new Error(`Unknown modifier "${p}" in "${chord}". Use ctrl, shift, alt or altgr.`);
    return m;
  });
  const keysym = KEY_ALIASES[key.toLowerCase()] ?? (/^f\d{1,2}$/i.test(key) ? key.toUpperCase() : key);
  return [...mods.flatMap((m) => ["-M", m]), "-k", keysym, ...mods.toReversed().flatMap((m) => ["-m", m])];
}

/**
 * Focuses the window (focus.on confirms it holds focus) before any input is
 * sent. Returns a check to run between inputs: focus may stay on the window or
 * move to one the input opened (a new window, or the same app's, e.g. a save
 * dialog), but focus on another existing window means the user clicked
 * elsewhere, so input stops there.
 */
async function focusForInput(focus: Focus, windowId: string) {
  const snap = await snapshot();
  const target = findWindow(snap, windowId);
  assertOutputs(target.output);
  const grab = await keyboardGrab();
  if (grab) {
    throw new Error(`A shell surface (${grab.namespace} on ${grab.output}) has the keyboard, so input wouldn't reach the window; nothing was sent.`);
  }
  await focus.on(windowId);
  const before = new Set(snap.windows.map((w) => w.id));
  const ours = (w: Window) => w.id === target.id || w.pid === target.pid || !before.has(w.id);
  /** `done` describes the input sent so far; null after the last input, when there's nothing left to stop. */
  return async (done: string | null) => {
    const now = await focusedWindow();
    if (now && ours(now)) return focus.settle();
    if (done !== null) throw new Error(`Focus moved to another window; stopped after ${done}.`);
  };
}

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
        "Focus a window and press key chords in order, e.g. ['ctrl+l', 'Return']. Keys are XKB names (a, Return, Escape, F5); modifiers are ctrl, shift, alt, altgr.",
      inputSchema: { window_id: z.string(), keys: z.array(z.string()).min(1).max(50) },
      annotations: { destructiveHint: true },
    },
    async ({ window_id, keys }) =>
      withFocus(
        async (focus) => {
          const args = keys.map(chordArgs); // validate everything before focusing
          const check = await focusForInput(focus, window_id);
          for (const [i, a] of args.entries()) {
            if (i > 0) await check(keys.slice(0, i).join(", "));
            await run("wtype", a);
          }
          await check(null);
          return json({ pressed: keys });
        },
        { restoreFocus: true },
      ),
  );

  const point = z.object({ x: z.number(), y: z.number() });
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
      },
      annotations: { destructiveHint: true },
    },
    async ({ x, y, button, count }) => json(await pointerInput(pointOrNull(x, y), clickOps(button, count))),
  );

  server.registerTool(
    "drag",
    {
      title: "Drag",
      description: "Press at one point, move to another, and release." + pointerNote,
      inputSchema: { from: point, to: point, button: z.enum(BUTTONS).default("left") },
      annotations: { destructiveHint: true },
    },
    async ({ from, to, button }) => json(await pointerInput(from, dragOps(await outputs(), from, to, button))),
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
      },
      annotations: { destructiveHint: true },
    },
    async ({ x, y, dx, dy }) => json(await pointerInput(pointOrNull(x, y), [{ op: "scroll", dx, dy }])),
  );
};

/** A point from optional coordinates: both or neither. */
function pointOrNull(x: number | undefined, y: number | undefined) {
  if ((x === undefined) !== (y === undefined)) throw new Error("Pass both x and y, or neither to use the pointer's position.");
  return x === undefined || y === undefined ? null : { x, y };
}
