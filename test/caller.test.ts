import { describe, expect, it } from "vitest";
import { identifyCaller, type Processes } from "../src/caller.ts";

const agentScope = "/user.slice/user-1000.slice/user@1000.service/app.slice/app-t3code.slice/app-t3code-agents.slice/app-t3code-agents-889e/t3code-claude-294c.scope";
const terminal = "/user.slice/user-1000.slice/user@1000.service/app.slice/app-umbriel-1394-1.scope";

/** A process tree: pid → [parent, environment, cgroup]; this process is pid 10. */
function tree(env: NodeJS.ProcessEnv, procs: Record<number, readonly [number, NodeJS.ProcessEnv, string?]>, cgroup: string): Processes {
  return {
    self: 10,
    env,
    parent: (pid) => (pid === 10 ? 9 : procs[pid]?.[0]),
    environ: (pid) => procs[pid]?.[1],
    cgroup: (pid) => (pid === 10 ? cgroup : procs[pid]?.[2]),
  };
}

describe("who runs a CLI command", () => {
  it("is the thread its environment names", () => {
    expect(identifyCaller(tree({ T3CODE_THREAD_ID: "a" }, {}, terminal))).toEqual({ kind: "agent", thread: "a", via: "environment" });
  });

  it("is still the thread when a launcher dropped its id (env -u, env -i): the nearest parent's", () => {
    const procs = { 9: [8, {}], 8: [7, { T3CODE_THREAD_ID: "a" }], 7: [1, { T3CODE_THREAD_ID: "server-wide" }] } as const;
    expect(identifyCaller(tree({}, procs, agentScope))).toEqual({ kind: "agent", thread: "a", via: "parent" });
  });

  it("is an agent it can't name when only its cgroup tells (systemd-run --scope, a double fork)", () => {
    expect(identifyCaller(tree({}, { 9: [1, {}] }, agentScope))).toEqual({ kind: "agent", via: "cgroup" });
  });

  it("is the user only in a terminal of the user's session or a login, never by the absence of an id", () => {
    expect(identifyCaller(tree({}, { 9: [1, {}] }, terminal))).toEqual({ kind: "user" });
    expect(identifyCaller(tree({}, { 9: [1, {}] }, "/user.slice/user-1000.slice/session-3.scope"))).toEqual({ kind: "user" });
    // A systemd-run unit, a service, or a cgroup it can't read: neither.
    for (const cgroup of ["/user.slice/user-1000.slice/user@1000.service/app.slice/run-u52.service", "/user.slice/user-1000.slice/user@1000.service/app.slice/miranda-mneme.service", ""]) {
      expect(identifyCaller(tree({}, { 9: [1, {}] }, cgroup))).toEqual({ kind: "other" });
    }
  });

  it("stops at a parent it can't read or a loop", () => {
    expect(identifyCaller(tree({}, { 9: [9, {}] }, terminal))).toEqual({ kind: "user" });
  });
});
