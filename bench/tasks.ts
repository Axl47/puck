import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { confirmationCode } from "./site/code.js";

/** Where the fixture site is served, on Linux and on the Mac alike. */
export const SITE = "http://localhost:8765/";

/**
 * What every agent is told before its task, whatever drives the desktop.
 * The Mac run sheet (bench/README.md) pastes the same text, so keep them in sync.
 */
export const PREAMBLE = `You are operating a computer. Helium (a web browser) shows the Lanternworks site at ${SITE}, and Obsidian has the "Puck Bench" vault open. Do the task through the desktop alone: look at the screen and use the mouse and keyboard. Don't use a terminal or shell, file tools, browser automation or developer tools, or the Obsidian CLI. When the task is done, reply DONE.`;

export type Check = { passed: boolean; detail: string };

export type Task = {
  id: string;
  prompt: string;
  /** Judges the vault after a run. */
  check: (vault: string) => Check;
};

const note = (vault: string, name: string) => {
  const path = join(vault, `${name}.md`);
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
};

// Typing by hand may straighten quotes and dashes or rewrap lines; none of that changes the words.
const normalize = (text: string) =>
  text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s*[—–]\s*/g, " - ")
    .replace(/\s+/g, " ")
    .trim();

const pass = (detail = "ok"): Check => ({ passed: true, detail });
const fail = (detail: string): Check => ({ passed: false, detail });

const LANTERN_RULE =
  "Never trust a flame you can’t see the base of — if the wick sits below the collar, trim it until the glow reaches the glass evenly, then wait ninety seconds before closing the hood. A lantern that smokes in the first minute will smoke all night.";

const BACKORDERED = ["Wick riser assembly", "Cold-blast tube, left", "Damper lever", "Mantle, large", "Shade bracket"];

const INBOX_BEFORE = readFileSync(new URL("./vault/Inbox.md", import.meta.url), "utf8");
const INBOX_AFTER = INBOX_BEFORE.replace("- QX-2291\n", "- QX-2291\n- QX-4705\n");

export const TASKS: readonly Task[] = [
  {
    id: "clip",
    prompt: `On the site's Field Guide page, find the section "The Lantern Rule". Create a new note in Obsidian named "Lantern Rule" whose body is that section's paragraph, word for word.`,
    check: (vault) => {
      const text = note(vault, "Lantern Rule");
      if (text === undefined) return fail('no note "Lantern Rule"');
      return normalize(text).includes(normalize(LANTERN_RULE)) ? pass() : fail("paragraph missing or altered");
    },
  },
  {
    id: "restock",
    prompt: `The site's Inventory page lists parts and their status. In the existing note "Restock", add a checklist item ("- [ ] " followed by the part name) for every part whose status is Backordered, in the order they appear on the page.`,
    check: (vault) => {
      const text = note(vault, "Restock");
      if (text === undefined) return fail('note "Restock" is gone');
      const items = [...text.matchAll(/^\s*- \[ \] (.+?)\s*$/gm)].map((m) => m[1]);
      const want = BACKORDERED.join(" | ");
      const got = items.join(" | ");
      return got === want ? pass() : fail(`got [${got}]`);
    },
  },
  {
    id: "dispatch",
    prompt: `Open Dispatch #47 from the site's Dispatches page and find its tracking code. In the note "Inbox", add that code as a new bullet at the end of the "Codes" list. Leave the rest of the note unchanged.`,
    check: (vault) => {
      const text = note(vault, "Inbox");
      if (text === undefined) return fail('note "Inbox" is gone');
      const tidy = (s: string) => s.replace(/[ \t]+$/gm, "").trimEnd();
      if (tidy(text) === tidy(INBOX_AFTER)) return pass();
      return text.includes("QX-4705") ? fail("code added, but the note differs elsewhere") : fail("code QX-4705 missing");
    },
  },
  {
    id: "signup",
    prompt: `On the site's Signup page, submit the form with the name "Puck Bench" and the plan "Team". Then set the "confirmation" property of the note "Account" to the confirmation code the site shows.`,
    check: (vault) => {
      const text = note(vault, "Account");
      if (text === undefined) return fail('note "Account" is gone');
      const value = text.match(/^---\n[\s\S]*?^confirmation:[ \t]*["']?([^"'\n]*?)["']?[ \t]*$/m)?.[1];
      const want = confirmationCode("Puck Bench", "Team");
      return value === want ? pass() : fail(`confirmation is ${JSON.stringify(value ?? null)}, want ${want}`);
    },
  },
];

export const task = (id: string) => {
  const found = TASKS.find((t) => t.id === id);
  if (!found) throw new Error(`unknown task ${id}; known: ${TASKS.map((t) => t.id).join(", ")}`);
  return found;
};
