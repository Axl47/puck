import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerArrange } from "./tools/arrange.ts";
import type { Session } from "./tools/common.ts";
import { registerInvasive } from "./tools/invasive.ts";
import { registerObserve } from "./tools/observe.ts";

/** True when the invasive tier (close, kill, typing) is enabled for this server. */
export const invasiveEnabled = () => process.env.PUCK_INVASIVE === "1";

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "puck", version: "0.1.0" },
    {
      instructions:
        "Puck sees and drives the user's real desktop (Umbriel compositor, Noctalia shell). Start with desktop_state. " +
        "This is the user's live session: take a layout_snapshot before rearranging and layout_restore it when your task doesn't need the new layout to stay. " +
        "Focus changes briefly move the user's cursor; batch your actions.",
    },
  );
  const session: Session = { owned: new Set() };
  registerObserve(server, session);
  registerArrange(server, session);
  if (invasiveEnabled()) registerInvasive(server, session);
  return server;
}

export async function serveStdio(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}
