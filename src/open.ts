import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desktop, desktopEnv, followPrivateDesktop, onDesktop, sleep, startPrivateDesktop } from "./exec.ts";
import { type Window, windows } from "./umbriel.ts";

/** How long a command that ended well may still be handing its window to the compositor. */
const AFTER_EXIT_MS = 2000;

/** The session a process is in. A detached command leads one of its own, and what it starts stays in it. */
function sessionOf(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // After the name, which may hold spaces: state, parent, process group, session.
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[3]);
  } catch {
    return null;
  }
}

const brief = ({ id, app_id, title }: Window) => ({ id, app_id, title });

/**
 * `puck open CMD`: runs CMD on the agent's private desktop (its ward's, or its
 * T3 thread's own, started here if it isn't up), detached, and waits for the
 * window it opens. The one way to open something for a check: it can't land on
 * the user's screen, the caller needn't keep the command in the background, and
 * every later Puck call acts on the same desktop.
 *
 * The window is the new one that belongs to the command's own processes, so two
 * opens at once each get their own. A command that only hands off (a launcher,
 * a second instance) ends without one: then any new window is returned, with a
 * note, or the windows that are there.
 */
export async function open(command: readonly string[], waitMs: number) {
  if (command.length === 0) throw new Error("open needs a command: puck open CMD…");
  const none = await startPrivateDesktop();
  if (none) throw new Error(`No private desktop here (${none}): \`puck open\` works in a T3 thread's shell or a warded worktree.`);
  followPrivateDesktop(true);
  return onDesktop(async () => {
    if (desktop() !== "private") throw new Error("The private desktop went away as it started; try again.");
    const before = new Set((await windows()).map((w) => w.id));
    // On the desktop's own disk folder, which goes when the desktop stops.
    const temp = desktopEnv().TMPDIR;
    const log = join(mkdtempSync(join(temp && existsSync(temp) ? temp : tmpdir(), "puck-open-")), "output.log");
    const out = openSync(log, "a");
    // `ward desktop -- CMD` becomes CMD, so this pid is the command's own, and (detached) its session's id.
    const child = spawn("ward", ["desktop", "--", ...command], { detached: true, stdio: ["ignore", out, out] });
    closeSync(out);
    let exit: { code: number | null; at: number } | undefined;
    child.once("exit", (code) => (exit = { code, at: Date.now() })).once("error", () => (exit = { code: 127, at: Date.now() }));
    child.unref();
    const result = ({ id, app_id, title, workspace, x, y, w: width, h: height }: Window) => ({
      desktop: desktop(),
      pid: exit ? null : child.pid,
      log,
      window: { id, app_id, title, workspace, x, y, width, height },
    });
    const fresh = async () => (await windows()).filter((w) => !before.has(w.id));
    const own = (ws: readonly Window[]) => ws.find((w) => sessionOf(w.pid) === child.pid);
    const started = Date.now();
    while (Date.now() - started < waitMs && !(exit?.code === 0 && Date.now() - exit.at > AFTER_EXIT_MS)) {
      await sleep(250);
      const mine = own(await fresh());
      if (mine) return result(mine);
      if (exit && exit.code !== 0) {
        const tail = readFileSync(log, "utf8").trim().split("\n").slice(-15).join("\n");
        throw new Error(`${command[0]} ended (${exit.code === null ? "killed" : `exit ${exit.code}`}) before opening a window${tail ? `:\n${tail}` : "."}`);
      }
    }
    // One last look, the command's own window first: it may have come up since the last one.
    const last = await fresh();
    const other = own(last) ?? last[0];
    if (other && own([other])) return result(other);
    const why = exit ? "The command ended without a window of its own" : `No window of the command's own within ${waitMs / 1000} s (it is still running)`;
    if (other) return { ...result(other), note: `${why}; this one opened meanwhile, from another process (a launcher hands off like that). Check that it is yours.` };
    return {
      desktop: desktop(),
      pid: exit ? null : child.pid,
      log,
      window: null,
      note: exit
        ? `${why}. If it handed off to a copy that was already running, look for it in \`windows\`; a copy running on the user's screen would have opened it there.`
        : `${why}. \`puck state\` lists the windows once it has one.`,
      windows: (await windows()).map(brief),
    };
  });
}
