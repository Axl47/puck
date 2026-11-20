import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerArrange } from "./tools/arrange.ts";
import type { Session } from "./tools/common.ts";
import { registerInvasive } from "./tools/invasive.ts";
import { registerObserve } from "./tools/observe.ts";
import { followPrivateDesktop, followsPrivateDesktop, onDesktop, startPrivateDesktop } from "./exec.ts";

/**
 * launch_app opens a window: on the agent's private desktop, started here if
 * needed, unless the agent chose the live session. Where there is no private
 * desktop to start it refuses, so nothing lands on the user's screen unasked.
 */
async function privateForOpening(): Promise<void> {
  if (!followsPrivateDesktop()) return;
  const none = await startPrivateDesktop();
  if (none) {
    throw new Error(
      `No private desktop to open this on (${none}). To check something yourself, run \`puck open CMD\` in your shell, which can tell your thread. If the user wants it on their own screen, call desktop_state with desktop "live" first.`,
    );
  }
}

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "puck", version: "0.1.0" },
    {
      instructions:
        "Puck sees and drives an Umbriel desktop. Start with desktop_state, which says which one. " +
        "To open an app, a dev build or a browser for a check, run `puck open CMD` in a shell (or launch_app for an installed app): it opens on your private desktop, which the user doesn't see, starts that desktop if needed, and prints the new window. " +
        "A private desktop is one 1280×720 output with no shell and only your own windows, so arrange it, click and type on it freely (Wayland apps only). Once you have one, Puck's tools act on it: in a T3 worktree with a ward from the start, elsewhere from your first open. " +
        "If desktop_state still says live after `puck open`, this server can't tell which thread it serves: drive your desktop with the `puck` CLI in your shell instead (`puck state`, `puck inspect`, `puck pointer`, `puck keys`). " +
        "Until your first open, or after desktop_state with desktop \"live\", Puck is on the user's live session (Noctalia shell), for what the user wants on their own screen: take a layout_snapshot before rearranging and layout_restore it when your task doesn't need the new layout to stay. " +
        "There, actions move the user's cursor onto the window they act on; batch them.",
    },
  );
  // Every tool call acts on one desktop, chosen as it starts (launch_app starts a private one first); desktop_state
  // chooses for itself, after the switch it may carry, so it can leave a private
  // desktop that doesn't start. The SDK types a handler by its tool's schema, so
  // the wrapper is put back to that type.
  const registerTool = server.registerTool.bind(server);
  server.registerTool = ((name, config, handler) => {
    if (name === "desktop_state") return registerTool(name, config, handler);
    const call = handler as (...args: unknown[]) => unknown;
    return registerTool(name, config, (async (...args: unknown[]) => {
      if (name === "launch_app") await privateForOpening();
      return onDesktop(() => call(...args));
    }) as typeof handler);
  }) as typeof registerTool;
  const session: Session = { owned: new Set() };
  registerObserve(server, session);
  registerArrange(server, session);
  registerInvasive(server, session);
  return server;
}

export async function serveStdio(): Promise<void> {
  followPrivateDesktop(true);
  await createServer().connect(new StdioServerTransport());
}
