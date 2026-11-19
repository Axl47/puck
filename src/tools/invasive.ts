import { z } from "zod";
import { run } from "../exec.ts";
import { findWindow, focusOn, focusedWindow, msg, snapshot, withFocus } from "../umbriel.ts";
import { type Register, json } from "./common.ts";

const MODIFIERS: Record<string, string> = {
  ctrl: "ctrl",
  control: "ctrl",
  shift: "shift",
  alt: "alt",
  altgr: "altgr",
  super: "logo",
  meta: "logo",
  logo: "logo",
  win: "logo",
};

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
  const mods = parts.map((p) => {
    const m = MODIFIERS[p.toLowerCase()];
    if (!m) throw new Error(`Unknown modifier "${p}" in "${chord}". Use ctrl, shift, alt, altgr or super.`);
    return m;
  });
  const keysym = KEY_ALIASES[key.toLowerCase()] ?? (/^f\d{1,2}$/i.test(key) ? key.toUpperCase() : key);
  return [...mods.flatMap((m) => ["-M", m]), "-k", keysym, ...mods.toReversed().flatMap((m) => ["-m", m])];
}

/** Focuses the window and confirms it holds focus before any input is sent. */
async function focusForInput(windowId: string) {
  findWindow(await snapshot(), windowId);
  await focusOn(windowId);
  if ((await focusedWindow())?.id !== windowId) throw new Error("Could not focus that window; no input was sent.");
}

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
      findWindow(await snapshot(), window_id);
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
        "Force-quit a window's app without letting it save. Last resort for a hung window. By default only windows launched with launch_app in this session.",
      inputSchema: { window_id: z.string(), owned_only: z.boolean().default(true) },
      annotations: { destructiveHint: true },
    },
    async ({ window_id, owned_only }) => {
      findWindow(await snapshot(), window_id);
      guardOwned(window_id, owned_only);
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
        async () => {
          await focusForInput(window_id);
          await run("wtype", ["--", text], { timeoutMs: 60_000 });
          return json({ typed: text.length });
        },
        { restoreFocus: true },
      ),
  );

  server.registerTool(
    "press_keys",
    {
      title: "Press keys",
      description:
        "Focus a window and press key chords in order, e.g. ['ctrl+l', 'Return']. Keys are XKB names (a, Return, Escape, F5); modifiers are ctrl, shift, alt, altgr, super.",
      inputSchema: { window_id: z.string(), keys: z.array(z.string()).min(1).max(50) },
      annotations: { destructiveHint: true },
    },
    async ({ window_id, keys }) =>
      withFocus(
        async () => {
          const args = keys.map(chordArgs); // validate everything before focusing
          await focusForInput(window_id);
          for (const a of args) await run("wtype", a);
          return json({ pressed: keys });
        },
        { restoreFocus: true },
      ),
  );
};
