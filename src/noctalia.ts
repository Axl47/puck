import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { run } from "./exec.ts";

const noctalia = async (...args: string[]) => (await run("noctalia", ["msg", ...args])).trim();

export type ThemeMode = "dark" | "light" | "auto";

/** Shell settings an agent can read in one go. */
export async function shellState(outputNames: readonly string[]) {
  const [theme, dnd, ...wallpapers] = await Promise.all([
    noctalia("theme-mode-get"),
    noctalia("notification-dnd-status"),
    ...outputNames.map((o) => noctalia("wallpaper-get", o)),
  ]);
  return {
    theme_mode: theme,
    do_not_disturb: dnd === "on",
    wallpapers: Object.fromEntries(outputNames.map((o, i) => [o, wallpapers[i] ?? ""])),
  };
}

export const setWallpaper = (path: string, output?: string) =>
  noctalia("wallpaper-set", ...(output ? [output] : []), path);
export const setThemeMode = (mode: ThemeMode) => noctalia("theme-mode-set", mode);
export const setDoNotDisturb = (on: boolean) => noctalia("notification-dnd-set", on ? "on" : "off");
export const clearActiveNotifications = () => noctalia("notification-clear-active");

// Noctalia's notification history file; ids are the freedesktop notification ids.
const HistorySchema = z.object({
  entries: z.array(
    z.object({
      active: z.boolean(),
      notification: z.object({
        id: z.number(),
        app_name: z.string(),
        summary: z.string(),
        body: z.string(),
        received_wall_ms: z.number(),
        urgency: z.string(),
      }),
    }),
  ),
});

export type Notification = {
  id: number;
  app: string;
  summary: string;
  body: string;
  received: string;
  active: boolean;
  urgency: string;
};

export function parseHistory(json: unknown): Notification[] {
  return HistorySchema.parse(json)
    .entries.map(({ active, notification: n }) => ({
      id: n.id,
      app: n.app_name,
      summary: n.summary,
      body: n.body,
      received: new Date(n.received_wall_ms).toISOString(),
      active,
      urgency: n.urgency,
    }))
    .sort((a, b) => b.received.localeCompare(a.received));
}

const historyPath = () =>
  join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "noctalia/notification_history.json");

/** Notifications, newest first. */
export async function notifications(): Promise<Notification[]> {
  return parseHistory(JSON.parse(await readFile(historyPath(), "utf8")));
}

/** Closes one notification through the freedesktop API, which Noctalia implements. */
export async function dismissNotification(id: number): Promise<void> {
  await run("gdbus", [
    "call",
    "--session",
    "--dest",
    "org.freedesktop.Notifications",
    "--object-path",
    "/org/freedesktop/Notifications",
    "--method",
    "org.freedesktop.Notifications.CloseNotification",
    String(id),
  ]);
}
