import { homedir } from "node:os";
import { join } from "node:path";

/** Where Puck keeps layout snapshots and full-resolution screenshots. */
export const stateDir = () => join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "puck");

/** Where Puck reads its T3 token. */
export const configDir = () => join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "puck");
