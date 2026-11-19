#!/usr/bin/env node
import { parseArgs } from "node:util";
import { TEXT_MODES, type InspectTarget, type TextMode, inspect, parsePoint, parseRegion } from "./inspect.ts";
import { loadLayout, restoreLayout, saveLayout } from "./layout.ts";
import { BUTTONS, type Button, clickOps, dragOps, movePointer, pointerInput } from "./pointer.ts";
import { serveStdio } from "./server.ts";
import { spendToday } from "./t3.ts";
import { describeDesktop } from "./tools/observe.ts";
import { outputs, snapshot } from "./umbriel.ts";

const usage = `Usage: puck <command>

  mcp              Run the MCP server on stdio (PUCK_INVASIVE=1 adds close, kill and typing)
  state            Print the desktop as agents see it
  snapshot [out…]  Save the layout of the given outputs (all when none) and print its id
  restore <id>     Put a saved layout back
  spend            Print today's agent spend from T3 as JSON
  inspect (--region X,Y,WxH | --window ID | --point X,Y | --pointer)
          [--text auto|accessibility|ocr|none] [--screenshot PATH] [--json]
                   What is there: window, process, URL, accessible element, text
  pointer          What is under the pointer (inspect --pointer --text none)
  pointer move X,Y
  pointer click [X,Y] [--button left|right|middle] [--count N]
  pointer drag X,Y X,Y [--button …]
  pointer scroll [X,Y] [--dx N] [--dy N]   (wheel steps; --dy=-3 scrolls up)
                   Pointer input; click, drag and scroll put the pointer and focus back

Coordinates are global logical pixels. PUCK_OUTPUTS limits pointer input to those outputs.`;

const [command = "mcp", ...args] = process.argv.slice(2);
const arg = args[0];
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

try {
  switch (command) {
    case "mcp":
      await serveStdio();
      break;
    case "state":
      print(describeDesktop(await snapshot(), new Set()));
      break;
    case "snapshot":
      print({ snapshot_id: (await saveLayout(args.length ? args : undefined)).id });
      break;
    case "restore":
      if (!arg) throw new Error("restore needs a snapshot id");
      print(await restoreLayout(loadLayout(arg)));
      break;
    case "inspect":
      print(await inspectCommand(args));
      break;
    case "pointer":
      print(await pointerCommand(args));
      break;
    case "spend":
      console.log(JSON.stringify(await spendToday()));
      break;
    default:
      console.error(usage);
      process.exit(command === "help" || command === "--help" ? 0 : 2);
  }
} catch (err) {
  console.error(`puck: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
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
    },
  });
  const button: Button = oneOf(values.button, BUTTONS, "--button") ?? "left";
  const points = positionals.map(parsePoint);
  const int = (v: string, flag: string) => {
    const n = Number(v);
    if (!Number.isInteger(n)) throw new Error(`${flag} must be an integer`);
    return n;
  };
  switch (action) {
    case "move":
      if (points.length !== 1) throw new Error("pointer move needs X,Y");
      return { moved_to: await movePointer(points[0]!) };
    case "click":
      return pointerInput(points[0] ?? null, clickOps(button, Math.min(Math.max(int(values.count, "--count"), 1), 3)));
    case "drag": {
      const [from, to] = points;
      if (!from || !to) throw new Error("pointer drag needs X,Y X,Y");
      return pointerInput(from, dragOps(await outputs(), from, to, button), [to]);
    }
    case "scroll":
      return pointerInput(points[0] ?? null, [{ op: "scroll", dx: int(values.dx, "--dx"), dy: int(values.dy, "--dy") }]);
    default:
      throw new Error(`Unknown pointer action "${action}"; use move, click, drag or scroll.`);
  }
}

