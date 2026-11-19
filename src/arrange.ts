import type { Snapshot, Workspace } from "./umbriel.ts";

export const ARRANGEMENTS = {
  /** Side by side for two windows, then recursive halves (Umbriel's dwindle). */
  split: "dwindle",
  /** The first window large, the rest stacked beside it. */
  master: "master",
} as const;
export type Arrangement = keyof typeof ARRANGEMENTS;

/**
 * Picks the workspace to arrange `ids` on, so other windows don't crowd them:
 * a workspace on `output` that holds nothing but some of these windows, else an
 * empty one, lowest index first.
 */
export function pickWorkspace(snap: Pick<Snapshot, "windows" | "workspaces">, output: string, ids: readonly string[]): Workspace {
  const wanted = new Set(ids);
  const candidates = snap.workspaces.filter((ws) => ws.output === output).sort((a, b) => a.index - b.index);
  const onlyOurs = candidates.find((ws) => {
    const inside = snap.windows.filter((w) => w.workspace === ws.id);
    return inside.length > 0 && inside.every((w) => wanted.has(w.id));
  });
  const empty = candidates.find((ws) => ws.window_count === 0);
  const pick = onlyOurs ?? empty;
  if (!pick) {
    throw new Error(`Every workspace on ${output} has other windows; pass \`workspace\` to choose one.`);
  }
  return pick;
}
