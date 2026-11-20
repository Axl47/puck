import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { desktop } from "../exec.ts";

export { allowedOutputs, assertOutputs, assertUnrestricted } from "../scope.ts";

/** Throws on a ward's desktop, which runs no shell: no notifications, theme or wallpaper. */
export function assertShell(what: string): void {
  if (desktop() === "ward") {
    throw new Error(`${what} belong to the Noctalia shell, and a ward's desktop runs none. desktop_state with desktop "live" moves you to the user's session.`);
  }
}

/** State shared by every tool in one server process. */
export type Session = {
  /** Windows this process launched; the only ones close/kill touch by default. */
  owned: Set<string>;
};

export type Register = (server: McpServer, session: Session) => void;

/** A tool result carrying JSON for the agent to read. */
export const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});
