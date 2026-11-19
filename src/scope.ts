/** Outputs mutating tools may touch, from PUCK_OUTPUTS (comma-separated); null means all. */
export function allowedOutputs(): string[] | null {
  const list = process.env.PUCK_OUTPUTS?.split(",").map((s) => s.trim()).filter(Boolean);
  return list?.length ? list : null;
}

/** Throws unless every output named may be changed under PUCK_OUTPUTS. */
export function assertOutputs(...names: string[]): void {
  const allowed = allowedOutputs();
  const denied = allowed ? names.filter((n) => !allowed.includes(n)) : [];
  if (denied.length) {
    throw new Error(`Puck is limited to ${allowed?.join(", ")} (PUCK_OUTPUTS); refusing to change ${denied.join(", ")}.`);
  }
}

/** Throws for global changes (shell settings, notifications) when PUCK_OUTPUTS limits Puck. */
export function assertUnrestricted(what: string): void {
  if (allowedOutputs()) throw new Error(`${what} affects the whole desktop; disabled while PUCK_OUTPUTS is set.`);
}
