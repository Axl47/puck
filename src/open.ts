import { execFile, spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { desktop, followPrivateDesktop, onDesktop, sleep } from "./exec.ts";
import { windows } from "./umbriel.ts";

/** How long a command that ended well may still be handing its window to the compositor. */
const AFTER_EXIT_MS = 2000;

/**
 * `puck open -- CMD`: runs CMD on the agent's private desktop (its ward's, or
 * its T3 thread's own, started here if it isn't up), detached, and waits for
 * the window it opens. The one way to open something for a check: it can't land
 * on the user's screen, the caller needn't keep the command in the background,
 * and every later Puck call acts on the same desktop.
 */
export async function open(command: readonly string[], waitMs: number) {
  if (command.length === 0) throw new Error("open needs a command: puck open -- CMD…");
  try {
    // Ward starts the desktop when a command runs on it, so a first window isn't missed while it comes up.
    await promisify(execFile)("ward", ["desktop", "--", "true"], { timeout: 90_000 });
  } catch (err) {
    const { code, stderr } = err as { code?: string | number; stderr?: string };
    if (code === "ENOENT") throw new Error("`puck open` needs Ward for the private desktop, and `ward` isn't on PATH.");
    if (code === 3) throw new Error("No private desktop here: `puck open` works in a T3 thread or a warded worktree.");
    throw new Error(`The private desktop didn't start: ${stderr?.trim() || (err instanceof Error ? err.message : String(err))}`);
  }
  followPrivateDesktop(true);
  return onDesktop(async () => {
    if (desktop() !== "private") throw new Error("The private desktop went away as it started; try again.");
    const before = new Set((await windows()).map((w) => w.id));
    const log = join(mkdtempSync(join(tmpdir(), "puck-open-")), "output.log");
    const out = openSync(log, "a");
    // `ward desktop -- CMD` becomes CMD, so this pid is the command's own.
    const child = spawn("ward", ["desktop", "--", ...command], { detached: true, stdio: ["ignore", out, out] });
    closeSync(out);
    let exit: { code: number | null; at: number } | undefined;
    child.once("exit", (code) => (exit = { code, at: Date.now() })).once("error", () => (exit = { code: 127, at: Date.now() }));
    const started = Date.now();
    while (Date.now() - started < waitMs && !(exit?.code === 0 && Date.now() - exit.at > AFTER_EXIT_MS)) {
      await sleep(250);
      const w = (await windows()).find((w) => !before.has(w.id));
      if (w) {
        child.unref();
        const { id, app_id, title, workspace, x, y, w: width, h: height } = w;
        return { desktop: desktop(), pid: child.pid, log, window: { id, app_id, title, workspace, x, y, width, height } };
      }
      if (exit && exit.code !== 0) {
        const tail = readFileSync(log, "utf8").trim().split("\n").slice(-15).join("\n");
        throw new Error(`${command[0]} ended (${exit.code === null ? "killed" : `exit ${exit.code}`}) before opening a window${tail ? `:\n${tail}` : "."}`);
      }
    }
    child.unref();
    return {
      desktop: desktop(),
      pid: exit ? null : child.pid,
      log,
      window: null,
      note: exit
        ? "The command ended without opening a new window; it may have handed off to one already open. `puck state` lists the windows."
        : `No window within ${waitMs / 1000} s; the command is still running. \`puck state\` lists the windows once it has one.`,
    };
  });
}
