import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { commandLine, parseDesktopEntry, resolveApp } from "../src/apps.ts";
import { pickWorkspace } from "../src/arrange.ts";
import { captureScale } from "../src/capture.ts";
import { extentOf, takeSnapshot } from "../src/layout.ts";
import { parseHistory } from "../src/noctalia.ts";
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

  it("reuses a workspace holding only the requested windows", () => {
    expect(pickWorkspace(snap, "DP-2", [spotify.id]).id).toBe("DP-2:6");
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

  it("records workspace, layout, visibility and width", () => {
    const saved = takeSnapshot(snap, g);
    expect(saved.activeWorkspaces).toEqual({ "DP-2": "DP-2:6", "HDMI-A-1": "HDMI-A-1:3" });
    expect(saved.windows.find((w) => w.workspace === "DP-2:6")?.extent).toBeCloseTo(0.9, 1);
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

  it("prefers exact matches and reports ambiguity", () => {
    expect(resolveApp("zed", all).id).toBe("dev.zed.Zed");
    expect(resolveApp("foot", all).id).toBe("foot");
    expect(resolveApp("heli", all).id).toBe("helium");
    expect(() => resolveApp("e", all)).toThrow(/several apps/);
  });
});

describe("capture scale", () => {
  it("caps inline shots at 1568 px and keeps full-res native", () => {
    const out = { kind: "output", name: "DP-2", width: 1600, height: 900, scale: 1.6 } as const;
    expect(captureScale(out, false) * 1600).toBeCloseTo(1568);
    expect(captureScale(out, true)).toBe(1.6);
    expect(captureScale({ ...out, width: 400, height: 300 }, false)).toBe(1.6);
  });
});

describe("chordArgs", () => {
  it("wraps keys in their modifiers", () => {
    expect(chordArgs("ctrl+shift+t")).toEqual(["-M", "ctrl", "-M", "shift", "-k", "t", "-m", "shift", "-m", "ctrl"]);
    expect(chordArgs("enter")).toEqual(["-k", "Return"]);
    expect(chordArgs("super+f5")).toEqual(["-M", "logo", "-k", "F5", "-m", "logo"]);
    expect(() => chordArgs("hyper+a")).toThrow(/Unknown modifier/);
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
