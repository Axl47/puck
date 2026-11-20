import { readFileSync } from "node:fs";

/**
 * Who runs a CLI command, which decides the desktop it may act on (DESIGN.md,
 * "Which desktop"). Environment alone can't say: a launcher (`env -i`,
 * `systemd-run`, a test runner, a tmux server started elsewhere) drops
 * T3CODE_THREAD_ID and WARD_ID, and their absence must not read as "the user".
 *
 * - `agent`: a T3 thread or a ward. `thread`/`ward` is its id when one is known:
 *   from this process's environment, or the nearest parent process's when a
 *   launcher dropped it on the way. Without either, only its cgroup (T3 puts
 *   every agent, and Ward every ward and desktop, under `app-t3code.slice`) gave
 *   it away, and Puck can't tell which thread it is.
 * - `user`: a terminal of the user's graphical session (an app scope or unit
 *   the session started) or a login session (a tty, ssh).
 * - `other`: anything else, such as a service (Miranda's recorder) or a
 *   `systemd-run` unit. It may look at the live session but not act on it.
 */
export type Caller =
  | { kind: "agent"; thread?: string; ward?: string; via: "environment" | "parent" | "cgroup" }
  | { kind: "user" }
  | { kind: "other" };

type Ids = { thread?: string; ward?: string };

/** What identifyCaller reads about processes: /proc by default, a made-up tree in tests. */
export interface Processes {
  readonly self: number;
  readonly env: NodeJS.ProcessEnv;
  /** The parent's pid, or undefined when it can't be read. */
  parent(pid: number): number | undefined;
  /** The process's environment, or undefined when it can't be read. */
  environ(pid: number): NodeJS.ProcessEnv | undefined;
  /** The process's cgroup v2 path (`/user.slice/…`), or undefined. */
  cgroup(pid: number): string | undefined;
}

const read = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

export const proc: Processes = {
  self: process.pid,
  env: process.env,
  // The command name in stat is in parentheses and may hold spaces or parentheses itself.
  parent: (pid) => Number(read(`/proc/${pid}/stat`)?.split(") ").at(-1)?.split(" ")[1]) || undefined,
  environ: (pid) => {
    const text = read(`/proc/${pid}/environ`);
    return text === undefined ? undefined : Object.fromEntries(text.split("\0").filter((v) => v.includes("=")).map((v) => [v.slice(0, v.indexOf("=")), v.slice(v.indexOf("=") + 1)]));
  },
  cgroup: (pid) => read(`/proc/${pid}/cgroup`)?.match(/^0::(.*)$/m)?.[1],
};

const ids = (env: NodeJS.ProcessEnv | undefined): Ids | undefined => {
  const thread = env?.T3CODE_THREAD_ID || undefined;
  const ward = env?.WARD_ID || undefined;
  return thread || ward ? { ...(thread && { thread }), ...(ward && { ward }) } : undefined;
};

/** T3's agents, and Ward's wards and desktops, which run in its agents' slice. */
const AGENT_CGROUP = /\/app-t3code\.slice\//;
/** What the user's session starts (a terminal from a launcher or keybind), and login sessions. */
const USER_CGROUP = /\/user@\d+\.service\/app\.slice\/app-[^/]+\.(?:scope|service)$|\/session-[^/]+\.scope$/;

/** Who runs this process (see Caller). */
export function identifyCaller(p: Processes = proc): Caller {
  const own = ids(p.env);
  if (own) return { kind: "agent", ...own, via: "environment" };
  // The nearest parent with an id is the most specific one: a thread's shell beats the server above it.
  const seen = new Set<number>();
  for (let pid = p.parent(p.self); pid !== undefined && pid > 1 && !seen.has(pid); pid = p.parent(pid)) {
    seen.add(pid);
    const found = ids(p.environ(pid));
    if (found) return { kind: "agent", ...found, via: "parent" };
  }
  const cgroup = p.cgroup(p.self) ?? "";
  if (AGENT_CGROUP.test(cgroup)) return { kind: "agent", via: "cgroup" };
  return USER_CGROUP.test(cgroup) ? { kind: "user" } : { kind: "other" };
}
