// Deterministic confirmation code for the Signup page. bench/tasks.ts imports
// this same file to know the expected answer, so the two can't drift.
export function confirmationCode(name, plan) {
  let h = 2166136261;
  for (const ch of `${name.trim()}|${plan}`) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0;
  return `LW-${(h % 900000 + 100000).toString()}`;
}
