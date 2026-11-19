import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commandLine, parseDesktopEntry, resolveApp, windowHints } from "../src/apps.ts";
import { pickWorkspace } from "../src/arrange.ts";
import { captureDensity, grimScale } from "../src/capture.ts";
import { chooseTextSource, parsePoint, parseRegion, processStartedAt } from "../src/inspect.ts";
import { extentOf, resolveRef, takeSnapshot } from "../src/layout.ts";
import { parseHistory } from "../src/noctalia.ts";
import { dragOps, layoutBounds, moveOp, windowAt } from "../src/pointer.ts";
import { assertOutputs, assertUnrestricted } from "../src/scope.ts";
import { chordArgs } from "../src/tools/invasive.ts";
import { describeDesktop } from "../src/tools/observe.ts";
import { type Snapshot, parseOutputs, parseWindows, parseWorkspaces } from "../src/umbriel.ts";

// Real `umbriel … --json` output captured on gaia-arch.
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`fixtures/${name}.json`, import.meta.url), "utf8")) as unknown;
const snap: Snapshot = {
  windows: parseWindows(fixture("windows")),
  workspaces: parseWorkspaces(fixture("workspaces")),
  outputs: parseOutputs(fixture("outputs")),
  focused: null,
};

describe("umbriel parsing", () => {
  it("reads the live JSON shapes", () => {
    expect(snap.outputs.map((o) => o.name).sort()).toEqual(["DP-2", "HDMI-A-1"]);
    expect(snap.workspaces).toHaveLength(8);
    expect(snap.windows[0]).toMatchObject({ app_id: "Spotify", workspace: "DP-2:6" });
  });

  it("describes the desktop with only the flags that are set", () => {
    const view = describeDesktop(snap, new Set([snap.windows[0]!.id]));
    expect(view.windows[0]).toMatchObject({ launched_by_puck: true, visible: true });
    expect(view.windows[0]).not.toHaveProperty("floating");
  });
});

describe("pickWorkspace", () => {
  const spotify = snap.windows.find((w) => w.app_id === "Spotify")!;

  it("reuses a workspace holding only the leading requested windows", () => {
    expect(pickWorkspace(snap, "DP-2", [spotify.id, "other"]).id).toBe("DP-2:6");
    // Spotify would end up first there, not second.
    expect(pickWorkspace(snap, "DP-2", ["other", spotify.id]).name).toBe("Browsers");
  });

  it("skips a workspace holding the windows in the wrong order", () => {
    const b = { ...spotify, id: "b", x: spotify.x - 500 }; // left of Spotify on the same workspace
    const swapped = { ...snap, windows: [...snap.windows, b] };
    expect(pickWorkspace(swapped, "DP-2", [spotify.id, "b"]).name).toBe("Browsers");
    expect(pickWorkspace(swapped, "DP-2", ["b", spotify.id]).id).toBe("DP-2:6");
  });

  it("otherwise picks the lowest-index empty workspace", () => {
    expect(pickWorkspace(snap, "DP-2", ["other"]).name).toBe("Browsers");
  });

  it("refuses when every workspace has someone else's windows", () => {
    const full = { ...snap, workspaces: snap.workspaces.map((ws) => ({ ...ws, window_count: 1 })) };
    expect(() => pickWorkspace(full, "DP-2", ["other"])).toThrow(/pass `workspace`/);
  });
});

describe("layout snapshots", () => {
  const g = { gap: 10, border: 2 };

  it("inverts Umbriel's column width formula", () => {
    // Measured: a 0.9 column on a 1600 px output is 1417 px; 0.5 on 1280 px is 621 px.
    expect(extentOf(1417, 1600, g)).toBeCloseTo(0.9, 2);
    expect(extentOf(621, 1280, g)).toBeCloseTo(0.5, 3);
  });

  it("scopes to the given outputs", () => {
    const saved = takeSnapshot(snap, g, ["HDMI-A-1"]);
    expect(saved.scope).toEqual(["HDMI-A-1"]);
    expect(saved.windows.every((w) => w.workspace.output === "HDMI-A-1")).toBe(true);
    expect(saved.workspaces.every((ws) => ws.ref.output === "HDMI-A-1")).toBe(true);
  });

  it("records workspace, layout, visibility and width", () => {
    const saved = takeSnapshot(snap, g);
    expect(saved.workspaces.filter((ws) => ws.active).map((ws) => `${ws.ref.output} ${ws.ref.name}`)).toEqual(["DP-2 Dump", "HDMI-A-1 Dump"]);
    expect(saved.windows.find((w) => w.workspace.name === "Dump")?.extent).toBeCloseTo(0.9, 1);
  });

  describe("resolveRef", () => {
    const ws = (id: string, name: string, named = false) => ({
      id, name, named, index: 0, output: "V", layout: "scrolling", active: false, focused: false, window_count: 0,
    });
    const ref = (windows: string[], id = "V:1") => ({ id, output: "V", name: "?", named: false, windows });
    const none = new Set<string>();

    it("finds named workspaces by name", () => {
      expect(resolveRef({ id: "V:2", output: "V", name: "Mail", named: true, windows: [] }, [ws("V:9", "Mail", true)], [], none)?.id).toBe("V:9");
    });

    it("prefers the recorded workspace while it exists", () => {
      // A and B were arranged together onto V:7, leaving their own V:6 with a newer window.
      const now = [ws("V:6", "1"), ws("V:7", "2"), ws("V:8", "3")];
      const wins = [{ id: "A", workspace: "V:7" }, { id: "B", workspace: "V:7" }, { id: "new", workspace: "V:6" }];
      expect(resolveRef(ref(["A", "B"], "V:6"), now, wins, none)?.id).toBe("V:6");
    });

    it("finds a dynamic workspace by the windows it held, after renumbering", () => {
      // A was alone on the first dynamic workspace; arranging moved it next to B, so that workspace vanished.
      const now = [ws("V:4", "1"), ws("V:5", "2")];
      const wins = [{ id: "A", workspace: "V:4" }, { id: "B", workspace: "V:4" }];
      expect(resolveRef(ref(["A"]), now, wins, none)?.id).toBe("V:5"); // V:4 also holds B, so A goes to the empty one
      const after = [{ id: "A", workspace: "V:5" }, { id: "B", workspace: "V:4" }];
      expect(resolveRef(ref(["B"]), now, after, new Set(["A"]))?.id).toBe("V:4");
    });

    it("keeps windows together that were together", () => {
      const now = [ws("V:4", "1"), ws("V:5", "2"), ws("V:6", "3")];
      const wins = [{ id: "A", workspace: "V:5" }, { id: "B", workspace: "V:4" }, { id: "C", workspace: "V:4" }];
      // A was already put back on V:5, so B (recorded with A) follows it there.
      expect(resolveRef(ref(["A", "B"]), now, wins, new Set(["A"]))?.id).toBe("V:5");
    });
  });
});

describe("apps", () => {
  const zed = parseDesktopEntry(
    "dev.zed.Zed",
    "[Desktop Entry]\nType=Application\nName=Zed\nExec=zeditor %U\nStartupWMClass=dev.zed.Zed\n[Desktop Action NewWorkspace]\nName=Open a new workspace\nExec=zeditor --new\n",
  )!;
  const helium = parseDesktopEntry("helium", "[Desktop Entry]\nType=Application\nName=Helium\nExec=helium-browser %U\n")!;
  const footServer = parseDesktopEntry("foot-server", "[Desktop Entry]\nType=Application\nName=Foot Server\nExec=foot --server\n")!;
  const foot = parseDesktopEntry("foot", "[Desktop Entry]\nType=Application\nName=Foot\nExec=foot\n")!;
  const all = [zed, helium, footServer, foot];

  it("reads the main group only and strips field codes", () => {
    expect(zed).toMatchObject({ name: "Zed", wmClass: "dev.zed.Zed" });
    expect(commandLine(zed)).toBe("zeditor");
  });

  it("skips hidden entries", () => {
    expect(parseDesktopEntry("x", "[Desktop Entry]\nType=Application\nName=X\nExec=x\nNoDisplay=true\n")).toBeNull();
  });

  it("hints at a launched window by WM class, id and program", () => {
    const wrapper = parseDesktopEntry("chromium", "[Desktop Entry]\nType=Application\nName=Chromium\nExec=env GDK_SCALE=1 /usr/bin/helium-browser %U\n")!;
    expect(windowHints(wrapper)).toEqual(["chromium", "helium-browser"]);
    expect(windowHints(zed)).toEqual(["dev.zed.zed", "dev.zed.zed", "zeditor"]);
  });

  it("prefers exact matches and reports ambiguity", () => {
    expect(resolveApp("zed", all).id).toBe("dev.zed.Zed");
    expect(resolveApp("foot", all).id).toBe("foot");
    expect(resolveApp("heli", all).id).toBe("helium");
    expect(() => resolveApp("e", all)).toThrow(/several apps/);
  });
});

describe("capture scale", () => {
  const out = { kind: "output", name: "DP-2", width: 1600, height: 900, scale: 1.6 } as const;

  it("caps inline shots at 1568 px and keeps full-res native", () => {
    expect(captureDensity(out, false) * 1600).toBeCloseTo(1568);
    expect(captureDensity(out, true)).toBe(1.6);
    expect(captureDensity({ ...out, width: 400, height: 300 }, false)).toBe(1.6);
  });

  it("scales window captures relative to their buffer", () => {
    // Measured: grim -T with -s 0.5 on a 1419 px window at 1.6x gives 1135 px, half the buffer.
    const win = { kind: "window", id: "w", width: 1419, height: 843, scale: 1.6 } as const;
    expect(grimScale(win, captureDensity(win, true))).toBe(1);
    expect(1419 * 1.6 * grimScale(win, captureDensity(win, false))).toBeCloseTo(1568);
  });
});

describe("chordArgs", () => {
  it("wraps keys in their modifiers", () => {
    expect(chordArgs("ctrl+shift+t")).toEqual(["-M", "ctrl", "-M", "shift", "-k", "t", "-m", "shift", "-m", "ctrl"]);
    expect(chordArgs("enter")).toEqual(["-k", "Return"]);
    expect(chordArgs("alt+f5")).toEqual(["-M", "alt", "-k", "F5", "-m", "alt"]);
    expect(() => chordArgs("hyper+a")).toThrow(/Unknown modifier/);
  });

  it("refuses super chords, which are desktop shortcuts", () => {
    expect(() => chordArgs("super+q")).toThrow(/desktop shortcut/);
    expect(() => chordArgs("Super_L")).toThrow(/desktop shortcut/);
  });
});

describe("notification history", () => {
  it("returns newest first with freedesktop ids", () => {
    const n = (id: number, ms: number, active: boolean) => ({
      active,
      notification: { id, app_name: "app", summary: `s${id}`, body: "", received_wall_ms: ms, urgency: "normal" },
    });
    const list = parseHistory({ change_serial: 1, entries: [n(1, 1000, false), n(2, 2000, true)] });
    expect(list.map((x) => [x.id, x.active])).toEqual([
      [2, true],
      [1, false],
    ]);
  });
});

describe("PUCK_OUTPUTS", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("allows everything when unset", () => {
    expect(() => assertOutputs("DP-2")).not.toThrow();
    expect(() => assertUnrestricted("x")).not.toThrow();
  });

  it("refuses outputs outside the list and global changes", () => {
    vi.stubEnv("PUCK_OUTPUTS", "PUCK-SBX");
    expect(() => assertOutputs("PUCK-SBX")).not.toThrow();
    expect(() => assertOutputs("PUCK-SBX", "DP-2")).toThrow(/refusing to change DP-2/);
    expect(() => assertUnrestricted("Changing shell settings")).toThrow(/PUCK_OUTPUTS/);
  });
});

describe("pointer geometry", () => {
  const spotify = snap.windows.find((w) => w.app_id === "Spotify")!;

  it("finds the visible window under a point, on the output there", () => {
    expect(windowAt(snap, { x: 2000, y: 400 })?.id).toBe(spotify.id); // the hidden T3 window overlaps it
    expect(windowAt(snap, { x: 100, y: 400 })).toBeNull();
    // A scrolled-away column keeps `visible` but lies outside its output.
    const offscreen = { ...spotify, id: "off", output: "HDMI-A-1", x: 1700 };
    expect(windowAt({ ...snap, windows: [offscreen] }, { x: 2000, y: 400 })).toBeNull();
  });

  it("prefers floating windows over the tiled ones beneath", () => {
    const dialog = { ...spotify, id: "dialog", floating: true, x: 1900, y: 300, w: 300, h: 200 };
    expect(windowAt({ ...snap, windows: [spotify, dialog] }, { x: 2000, y: 400 })?.id).toBe("dialog");
  });

  it("maps points onto the bounding box of all outputs", () => {
    expect(layoutBounds(snap.outputs)).toEqual({ x: 0, y: 0, width: 3200, height: 900 });
    expect(moveOp(snap.outputs, { x: 2000.4, y: 450 })).toEqual({ op: "move", x: 2000, y: 450, width: 3200, height: 900 });
    expect(moveOp(snap.outputs, { x: 1599.6, y: 0 })).toMatchObject({ x: 1599 }); // stays on HDMI-A-1
    expect(() => moveOp(snap.outputs, { x: 4000, y: 10 })).toThrow(/no output/);
  });

  it("drags from press to release through intermediate motion", () => {
    const ops = dragOps(snap.outputs, { x: 100, y: 100 }, { x: 300, y: 500 }, "left", 4);
    expect(ops[0]).toEqual({ op: "button", button: "left", state: "press" });
    expect(ops.at(-1)).toEqual({ op: "button", button: "left", state: "release" });
    const moves = ops.filter((o) => o.op === "move");
    expect(moves.map((m) => [m.x, m.y])).toEqual([
      [150, 200],
      [200, 300],
      [250, 400],
      [300, 500],
    ]);
  });
});

describe("inspect", () => {
  it("parses regions and points", () => {
    expect(parseRegion("10,-20,300x40")).toEqual({ x: 10, y: -20, width: 300, height: 40 });
    expect(parsePoint(" 1600.5,0 ")).toEqual({ x: 1600.5, y: 0 });
    expect(() => parseRegion("10,20,0x40")).toThrow(/empty/);
    expect(() => parseRegion("10,20 300x40")).toThrow(/X,Y,WxH/);
  });

  it("reads process start time from /proc, past a command name with spaces and parens", () => {
    // /proc/<pid>/stat: pid, (comm), then state (field 3) … starttime (field 22) in ticks.
    const fields = Array.from({ length: 50 }, (_, i) => (i === 0 ? "S" : i === 19 ? "12345" : "0"));
    const started = processStartedAt(`4242 (Web Content (x)) ${fields.join(" ")}`, 1_700_000_000);
    expect(started.toISOString()).toBe(new Date((1_700_000_000 + 123.45) * 1000).toISOString());
  });

  it("uses accessibility text when it covers the target, OCR otherwise", () => {
    expect(chooseTextSource("auto", "Pricing", true)).toBe("accessibility");
    expect(chooseTextSource("auto", "  ", true)).toBe("ocr");
    expect(chooseTextSource("auto", "Pricing", false)).toBe("ocr"); // region spills past the window
    expect(chooseTextSource("auto", null, true)).toBe("ocr");
    expect(chooseTextSource("ocr", "Pricing", true)).toBe("ocr");
    expect(chooseTextSource("none", "Pricing", true)).toBe("none");
  });
});
