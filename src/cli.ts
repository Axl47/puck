#!/usr/bin/env node
import { parseArgs } from "node:util";
import { TEXT_MODES, type InspectTarget, type TextMode, inspect, parsePoint, parseRegion } from "./inspect.ts";
import { pressKeys, typeText } from "./keys.ts";
import { loadLayout, restoreLayout, saveLayout } from "./layout.ts";
import { BUTTONS, type Button, clickOps, dragOps, fromWindow, movePointer, pointerInput } from "./pointer.ts";
import { identifyCaller } from "./caller.ts";
import { desktop, followPrivateDesktop, onDesktop } from "./exec.ts";
import { open } from "./open.ts";
import { serveStdio } from "./server.ts";
import { spendToday } from "./t3.ts";
import { focusWindow } from "./tools/arrange.ts";
import { describeDesktop } from "./tools/observe.ts";
import { snapshot } from "./umbriel.ts";

const usage = `Usage: puck <command>

  mcp              Run the MCP server on stdio (PUCK_INVASIVE=1 lets close, kill and input act on the live session)
  open [--wait SECONDS] [--] CMD…
                   Run CMD on your private desktop, which the user doesn't see (your ward's,
                   or your T3 thread's own, started if needed), and print the window it opens
                   (waits 15 s unless told otherwise). CMD keeps running; its output goes to the file printed as log
  state            Print the desktop as agents see it, with every window's id
  snapshot [out…]  Save the layout of the given outputs (all when none) and print its id
  restore <id>     Put a saved layout back
  spend            Print today's agent spend from T3 as JSON
  inspect (--region X,Y,WxH | --window ID | --point X,Y | --pointer)
          [--text auto|accessibility|ocr|none] [--screenshot PATH] [--json]
                   What is there: window, process, URL, accessible element, text
  pointer          What is under the pointer (inspect --pointer --text none)
  pointer move X,Y [--window ID]
  pointer click [X,Y] [--window ID] [--button left|right|middle] [--count N] [--overlay NS]
  pointer drag X,Y X,Y [--window ID] [--button …] [--overlay NS]
  pointer scroll [X,Y] [--window ID] [--dx N] [--dy N] [--overlay NS]   (wheel steps; --dy=-3 scrolls up)
                   Pointer input; click, drag and scroll put the pointer and focus back
  keys (--window ID | --overlay NS) CHORD…
                   Press key chords, e.g. ctrl+l Return, into a window or an overlay. Keys are
                   XKB names (a, Return, Escape, F5); modifiers are ctrl, shift, alt, altgr
  type --window ID TEXT
                   Type text into a window, e.g. puck type --window ID 'echo hi' (then keys … Return)
  focus ID         Give a window the keyboard and bring it into view (one scrolled away can't be clicked)

Window ids are the ones open and state print. Coordinates are logical pixels: global, or
with --window ID counted from that window's top-left corner (on a private desktop, the
pixels of a screenshot of it; elsewhere a screenshot may be scaled).
Input is refused while a shell surface has the keyboard; --overlay NS sends it into
that layer-shell namespace instead (selection for slurp), and only if it's open there.
PUCK_OUTPUTS limits input to those outputs.
An agent's commands act on its private desktop once it has one: in a ward always, in
another T3 thread after its first \`puck open\`, and never fall back to the live session
afterwards. PUCK_DESKTOP=live acts on the live session; pointer, keys, type and focus
reach it only with that, unless run from a terminal of the user's own session.`;

const [command = "mcp", ...args] = process.argv.slice(2);
const arg = args[0];
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
const asksForLive = process.env.PUCK_DESKTOP === "live";
const caller = identifyCaller();

try {
  if (command === "mcp") await serveStdio();
  else if (command === "spend") console.log(JSON.stringify(await spendToday()));
  else if (!["open", "state", "snapshot", "restore", "inspect", "pointer", "keys", "type", "focus"].includes(command)) {
    console.error(usage);
    process.exit(command === "help" || command === "--help" ? 0 : 2);
  } else {
    if (caller.kind === "agent" && !asksForLive) {
      // A launcher dropped the thread's id on the way here: `ward` finds the desktop by it.
      if (caller.via === "parent") Object.assign(process.env, caller.thread && { T3CODE_THREAD_ID: caller.thread }, caller.ward && { WARD_ID: caller.ward });
      if (caller.via === "cgroup") {
        throw new Error(
          "This runs in a T3 agent's processes, but neither its environment nor a parent's says which thread or ward (T3CODE_THREAD_ID, WARD_ID), so Puck can't find its private desktop and won't guess the user's screen. Run it from the thread's own shell, or with PUCK_DESKTOP=live for the user's screen.",
        );
      }
    }
    if (command === "open") print(await openCommand(args));
    else {
      // An agent's private desktop, if it has one: its shell has the live session's environment.
      followPrivateDesktop(caller.kind === "agent" && !asksForLive);
      await onDesktop(runCommand);
    }
  }
} catch (err) {
  console.error(`puck: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

/** The commands that act on a desktop. */
async function runCommand(): Promise<void> {
  switch (command) {
    case "state":
      print({ desktop: desktop(), ...describeDesktop(await snapshot(), new Set()) });
      break;
    case "snapshot":
      print({ snapshot_id: (await saveLayout(args.length ? args : undefined)).id });
      break;
    case "restore":
      if (!arg) throw new Error("restore needs a snapshot id");
      print(await restoreLayout(loadLayout(arg)));
      break;
    case "inspect":
      print({ desktop: desktop(), ...(await inspectCommand(args)) });
      break;
    case "pointer":
      if (arg) assertInput();
      print(await pointerCommand(args));
      break;
    case "keys":
      assertInput();
      print(await keysCommand(args));
      break;
    case "focus":
      assertInput();
      if (!arg) throw new Error("focus needs a window id");
      print(await focusWindow(arg));
      break;
    case "type": {
      assertInput();
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { window: { type: "string" } } });
      if (values.window === undefined || !positionals.length) throw new Error("type needs --window ID and the text");
      print(await typeText(values.window, positionals.join(" ")));
      break;
    }
  }
}

/**
 * Input reaches the user's live session only from the user's own terminal, or
 * with PUCK_DESKTOP=live: an agent's commands still resolve there before its
 * first open, and a command that can't be placed (a service, a systemd-run
 * unit) may be an agent's that lost its thread on the way.
 */
function assertInput(): void {
  if (desktop() !== "live" || caller.kind === "user" || asksForLive) return;
  throw new Error(
    caller.kind === "agent"
      ? "This would act on the user's live session. For your own private desktop, open something there first (`puck open CMD`); for the user's screen, run it with PUCK_DESKTOP=live."
      : "This would act on the user's live session, and Puck can't tell this command comes from the user: it isn't in a terminal of the user's session. Run it with PUCK_DESKTOP=live if it should.",
  );
}

function openCommand(argv: string[]) {
  // Only what comes before the command is Puck's: the command's own flags stay with it.
  let rest = argv;
  let seconds = 15;
  const wait = /^--wait(?:=(.*))?$/.exec(rest[0] ?? "");
  if (wait) {
    seconds = Number(wait[1] ?? rest[1]);
    if (!(seconds > 0)) throw new Error("--wait takes a number of seconds");
    rest = rest.slice(wait[1] === undefined ? 2 : 1);
  }
  if (rest[0] === "--") rest = rest.slice(1);
  else if (rest[0]?.startsWith("-")) throw new Error(`Unknown option ${rest[0]}; put -- before a command that starts with a dash.`);
  return open(rest, seconds * 1000);
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], flag: string): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) throw new Error(`${flag} must be one of ${allowed.join(", ")}`);
  return value as T;
}

async function inspectCommand(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      region: { type: "string" },
      window: { type: "string" },
      point: { type: "string" },
      pointer: { type: "boolean" },
      text: { type: "string", default: "auto" },
      screenshot: { type: "string" },
      json: { type: "boolean" }, // output is always JSON
    },
  });
  const targets: InspectTarget[] = [
    ...(values.region ? [{ kind: "region", rect: parseRegion(values.region) } as const] : []),
    ...(values.window ? [{ kind: "window", id: values.window } as const] : []),
    ...(values.point ? [{ kind: "point", point: parsePoint(values.point) } as const] : []),
    ...(values.pointer ? [{ kind: "pointer" } as const] : []),
  ];
  const [target, ...extra] = targets;
  if (!target || extra.length) throw new Error("inspect needs exactly one of --region, --window, --point, --pointer");
  const text: TextMode = oneOf(values.text, TEXT_MODES, "--text") ?? "auto";
  return inspect(target, { text, screenshot: values.screenshot });
}

async function pointerCommand(argv: string[]) {
  const [action, ...rest] = argv;
  if (!action) return inspect({ kind: "pointer" }, { text: "none" });
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      button: { type: "string", default: "left" },
      count: { type: "string", default: "1" },
      dx: { type: "string", default: "0" },
      dy: { type: "string", default: "0" },
      overlay: { type: "string" },
      window: { type: "string" },
    },
  });
  const button: Button = oneOf(values.button, BUTTONS, "--button") ?? "left";
  if (values.window !== undefined && !positionals.length) throw new Error("--window needs X,Y");
  const { points, still } = await fromWindow(values.window, positionals.map(parsePoint));
  const opts = { overlay: values.overlay, still };
  const int = (v: string, flag: string) => {
    const n = Number(v);
    if (!Number.isInteger(n)) throw new Error(`${flag} must be an integer`);
    return n;
  };
  switch (action) {
    case "move":
      if (points.length !== 1) throw new Error("pointer move needs X,Y");
      return { moved_to: await movePointer(points[0]!, still) };
    case "click":
      const count = Math.min(Math.max(int(values.count, "--count"), 1), 3);
      return pointerInput(points[0] ?? null, () => clickOps(button, count), opts);
    case "drag": {
      const [from, to] = points;
      if (!from || !to) throw new Error("pointer drag needs X,Y X,Y");
      return pointerInput(from, (outs) => dragOps(outs, from, to, button), opts);
    }
    case "scroll":
      const scroll = { op: "scroll", dx: int(values.dx, "--dx"), dy: int(values.dy, "--dy") } as const;
      return pointerInput(points[0] ?? null, () => [scroll], opts);
    default:
      throw new Error(`Unknown pointer action "${action}"; use move, click, drag or scroll.`);
  }
}


async function keysCommand(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { window: { type: "string" }, overlay: { type: "string" } },
  });
  if (!positionals.length) throw new Error("keys needs at least one chord, e.g. Escape or ctrl+l");
  if (values.window !== undefined && values.overlay === undefined) return pressKeys({ window: values.window }, positionals);
  if (values.overlay !== undefined && values.window === undefined) return pressKeys({ overlay: values.overlay }, positionals);
  throw new Error("keys needs exactly one of --window and --overlay");
}
