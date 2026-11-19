#!/usr/bin/env node
import { loadLayout, restoreLayout, saveLayout } from "./layout.ts";
import { serveStdio } from "./server.ts";
import { spendToday } from "./t3.ts";
import { describeDesktop } from "./tools/observe.ts";
import { snapshot } from "./umbriel.ts";

const usage = `Usage: puck <command>

  mcp              Run the MCP server on stdio (PUCK_INVASIVE=1 adds close, kill and typing)
  state            Print the desktop as agents see it
  snapshot [out…]  Save the layout of the given outputs (all when none) and print its id
  restore <id>     Put a saved layout back
  spend            Print today's agent spend from T3 as JSON`;

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
