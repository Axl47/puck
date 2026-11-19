import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export type DesktopEntry = {
  /** Desktop file id without `.desktop`, e.g. `dev.zed.Zed`. */
  id: string;
  name: string;
  exec: string;
  wmClass: string | undefined;
  /** Runs inside a terminal (Terminal=true). */
  terminal: boolean;
};

function applicationDirs(): string[] {
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share");
  const dataDirs = (process.env.XDG_DATA_DIRS ?? "/usr/local/share:/usr/share").split(":");
  return [dataHome, ...dataDirs, "/var/lib/flatpak/exports/share", join(dataHome, "flatpak/exports/share")].map((d) =>
    join(d, "applications"),
  );
}

/** Parses the `[Desktop Entry]` group of a .desktop file; null for hidden or non-application entries. */
export function parseDesktopEntry(id: string, text: string): DesktopEntry | null {
  const fields = new Map<string, string>();
  let inMain = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("[")) {
      inMain = line.trim() === "[Desktop Entry]";
      continue;
    }
    const eq = line.indexOf("=");
    if (inMain && eq > 0) fields.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  const name = fields.get("Name");
  const exec = fields.get("Exec");
  if (fields.get("Type") !== "Application" || !name || !exec) return null;
  if (fields.get("NoDisplay") === "true" || fields.get("Hidden") === "true") return null;
  return { id, name, exec, wmClass: fields.get("StartupWMClass"), terminal: fields.get("Terminal") === "true" };
}

/** Every launchable app; earlier directories win, as in the XDG spec. */
export function desktopEntries(): DesktopEntry[] {
  const seen = new Map<string, DesktopEntry>();
  for (const dir of applicationDirs()) {
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".desktop"));
    } catch {
      continue;
    }
    for (const file of files) {
      const id = basename(file, ".desktop");
      if (seen.has(id)) continue;
      const entry = parseDesktopEntry(id, readFileSync(join(dir, file), "utf8"));
      if (entry) seen.set(id, entry);
    }
  }
  return [...seen.values()];
}

/** Finds one app by desktop id or name: exact match first, then a unique substring match. */
export function resolveApp(query: string, entries: readonly DesktopEntry[]): DesktopEntry {
  const q = query.toLowerCase();
  const exact = entries.filter((e) => e.id.toLowerCase() === q || e.name.toLowerCase() === q);
  if (exact.length === 1 && exact[0]) return exact[0];
  const partial = exact.length > 1 ? exact : entries.filter((e) => `${e.id} ${e.name}`.toLowerCase().includes(q));
  if (partial.length === 1 && partial[0]) return partial[0];
  if (partial.length === 0) throw new Error(`No installed app matches "${query}".`);
  const options = partial.slice(0, 10).map((e) => `${e.name} (${e.id})`);
  throw new Error(`"${query}" matches several apps; use one of these ids: ${options.join(", ")}`);
}

/** Lowercase names a launched window's app_id may match: its WM class, desktop id and program name. */
export function windowHints(entry: DesktopEntry): string[] {
  const program = commandLine(entry)
    .split(" ")
    .find((t) => t !== "env" && !t.includes("="));
  return [entry.wmClass, entry.id, program && basename(program.replace(/^["']|["']$/g, ""))]
    .filter((h): h is string => !!h)
    .map((h) => h.toLowerCase());
}

/** The Exec line with desktop field codes (%U, %f, …) removed. */
export const commandLine = (entry: DesktopEntry) =>
  entry.exec
    .replace(/%[fFuUdDnNickvm]/g, "")
    .replace(/%%/g, "%")
    .replace(/\s+/g, " ")
    .trim();
