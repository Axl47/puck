import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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
