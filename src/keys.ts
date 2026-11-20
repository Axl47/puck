import { run } from "./exec.ts";
import { allowedOutputs, assertOutputs } from "./scope.ts";
import {
  type Focus,
  type Layer,
  type Window,
  findWindow,
  focusedWindow,
  keyboardGrab,
  layers,
  snapshot,
  withDesktopLock,
  withFocus,
} from "./umbriel.ts";

// Key chords through wtype, into a window or into a shell overlay holding the keyboard.

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
export async function focusForInput(focus: Focus, windowId: string) {
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

/**
 * Why keys must not go to the `overlay` namespace, or null to go ahead: that
 * overlay must hold the keyboard, and under PUCK_OUTPUTS the client showing it
 * (slurp maps one surface per output; the keyboard lands on one of them) must
 * show it on an allowed output.
 */
export function overlayKeysRefusal(all: readonly Layer[], overlay: string, allowed: readonly string[] | null): string | null {
  const grab = all.find((l) => l.mapped && l.focused);
  if (!grab) return `No shell surface has the keyboard, so there's no ${overlay} overlay to type into; nothing was sent.`;
  if (grab.namespace !== overlay) return `${grab.namespace} has the keyboard, not ${overlay}; nothing was sent.`;
  const shown = all.filter((l) => l.mapped && l.namespace === overlay && l.pid === grab.pid).map((l) => l.output);
  if (allowed && !shown.some((o) => allowed.includes(o))) {
    return `The ${overlay} overlay isn't on ${allowed.join(", ")} (PUCK_OUTPUTS); nothing was sent.`;
  }
  return null;
}

const TYPE_CHUNK = 64;

/** Focuses a window and types text into it as keyboard input, then gives focus back. */
export function typeText(windowId: string, text: string) {
  return withFocus(
    async (focus) => {
      const check = await focusForInput(focus, windowId);
      // In chunks (of code points, so emoji stay whole), re-checking focus between them.
      const chars = Array.from(text);
      for (let i = 0; i < chars.length; i += TYPE_CHUNK) {
        if (i > 0) await check(`${i} characters`);
        await run("wtype", ["--", chars.slice(i, i + TYPE_CHUNK).join("")], { timeoutMs: 30_000 });
      }
      await check(null);
      return { typed: chars.length };
    },
    { restoreFocus: true },
  );
}

export type KeyTarget = { window: string } | { overlay: string };

/**
 * Presses chords in order. Into a window: focused first (and checked between
 * chords), focus given back afterwards. Into an overlay: under the desktop lock,
 * re-checking between chords that the overlay still has the keyboard.
 */
export async function pressKeys(target: KeyTarget, keys: readonly string[]) {
  const args = keys.map(chordArgs); // validate everything before sending anything
  if ("overlay" in target) {
    return withDesktopLock(async () => {
      for (const [i, a] of args.entries()) {
        const refusal = overlayKeysRefusal(await layers(), target.overlay, allowedOutputs());
        if (refusal) throw new Error(i ? `${refusal.replace(/; nothing was sent\.$/, "")}; stopped after ${keys.slice(0, i).join(", ")}.` : refusal);
        await run("wtype", a);
      }
      return { pressed: keys, into: target.overlay };
    });
  }
  return withFocus(
    async (focus) => {
      const check = await focusForInput(focus, target.window);
      for (const [i, a] of args.entries()) {
        if (i > 0) await check(keys.slice(0, i).join(", "));
        await run("wtype", a);
      }
      await check(null);
      return { pressed: keys };
    },
    { restoreFocus: true },
  );
}
