import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerArrange } from "./tools/arrange.ts";
import type { Session } from "./tools/common.ts";
import { registerInvasive } from "./tools/invasive.ts";
import { registerObserve } from "./tools/observe.ts";
import { followWardDesktop } from "./exec.ts";

/** True when the invasive tier (close, kill, typing) is enabled for this server. */
export const invasiveEnabled = () => process.env.PUCK_INVASIVE === "1";

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "puck", version: "0.1.0" },
    {
      instructions:
        "Puck sees and drives an Umbriel desktop. Start with desktop_state, which says which one. " +
        "In a T3 worktree with a ward it is the ward's private desktop: one 1280×720 output, no shell, only your own windows, so arrange it freely. Programs you start with `ward desktop -- CMD` open on it (Wayland apps only), as does launch_app. " +
        "Anywhere else, or after desktop_state with desktop \"live\", it is the user's live session (Noctalia shell): take a layout_snapshot before rearranging and layout_restore it when your task doesn't need the new layout to stay. " +
        "There, actions move the user's cursor onto the window they act on; batch them.",
    },
  );
  const session: Session = { owned: new Set() };
  registerObserve(server, session);
  registerArrange(server, session);
  if (invasiveEnabled()) registerInvasive(server, session);
  return server;
}

export async function serveStdio(): Promise<void> {
  followWardDesktop(true);
  await createServer().connect(new StdioServerTransport());
}
