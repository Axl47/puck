import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerArrange } from "./tools/arrange.ts";
import type { Session } from "./tools/common.ts";
import { registerInvasive } from "./tools/invasive.ts";
import { registerObserve } from "./tools/observe.ts";
import { followPrivateDesktop, onDesktop } from "./exec.ts";

/** True when the invasive tier (close, kill, typing) is enabled for this server. */
export const invasiveEnabled = () => process.env.PUCK_INVASIVE === "1";

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "puck", version: "0.1.0" },
    {
      instructions:
        "Puck sees and drives an Umbriel desktop. Start with desktop_state, which says which one. " +
        "To open an app, a dev build or a browser for a check, run `puck open -- CMD` in a shell: it opens on your private desktop, which the user never sees, starts that desktop if needed, and prints the new window. " +
        "A private desktop is one 1280×720 output with no shell and only your own windows, so arrange it freely (Wayland apps only). Once you have one, Puck's tools act on it: in a T3 worktree with a ward from the start, elsewhere from your first `puck open`. " +
        "Until then, or after desktop_state with desktop \"live\", Puck is on the user's live session (Noctalia shell), for what the user wants on their own screen: take a layout_snapshot before rearranging and layout_restore it when your task doesn't need the new layout to stay. " +
        "There, actions move the user's cursor onto the window they act on; batch them.",
    },
  );
  // Every tool call acts on one desktop, chosen as it starts; desktop_state
  // chooses for itself, after the switch it may carry, so it can leave a private
  // desktop that doesn't start. The SDK types a handler by its tool's schema, so
  // the wrapper is put back to that type.
  const registerTool = server.registerTool.bind(server);
  server.registerTool = ((name, config, handler) => {
    if (name === "desktop_state") return registerTool(name, config, handler);
    const call = handler as (...args: unknown[]) => unknown;
    return registerTool(name, config, ((...args: unknown[]) => onDesktop(() => call(...args))) as typeof handler);
  }) as typeof registerTool;
  const session: Session = { owned: new Set() };
  registerObserve(server, session);
  registerArrange(server, session);
  if (invasiveEnabled()) registerInvasive(server, session);
  return server;
}

export async function serveStdio(): Promise<void> {
  followPrivateDesktop(true);
  await createServer().connect(new StdioServerTransport());
}
