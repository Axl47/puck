#!/usr/bin/env python3
"""Reads a window's accessibility (AT-SPI) tree for `puck inspect`.

  a11y.py '<json request>'

Request: {"pid": n, "title": s, "window": {x, y, width, height},
          "point": {x, y} | null, "rect": {x, y, width, height} | null, "text": bool,
          "clip": bool (keep only text inside rect)}
in global logical coordinates, as Umbriel reports them.
Prints {"found": bool, "url": s | null, "element": {...} | null, "text": s | null}.

On Wayland, apps report extents relative to their own window, so boxes are
mapped through the window's geometry: offset by the frame's origin (client-side
shadows), and, outside web documents, scaled by window size / frame size
(Chromium's UI reports at its own scale while its page content doesn't).
"""
import json
import sys
import time
import warnings

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi  # noqa: E402

S = Atspi.StateType
warnings.simplefilter("ignore", DeprecationWarning)  # the replacements need a newer libatspi
NODE_BUDGET = 6000
TIME_BUDGET = 4.0
DOCUMENT_ROLES = {Atspi.Role.DOCUMENT_WEB, Atspi.Role.DOCUMENT_FRAME}
FRAME_ROLES = {Atspi.Role.FRAME, Atspi.Role.WINDOW, Atspi.Role.DIALOG}
OBJECT_CHAR = "￼"  # stands in for a child object inside its parent's text


class Budget(Exception):
    pass


class Tree:
    def __init__(self, frame, window):
        self.frame = frame
        self.window = window
        fx, fy, fw, fh = extents(frame) or (0, 0, window["width"], window["height"])
        self.origin = (fx, fy)
        self.ui_scale = (window["width"] / fw if fw > 0 else 1, window["height"] / fh if fh > 0 else 1)
        self.visited = 0
        self.clip = False
        self.partial = False
        self.deadline = time.monotonic() + TIME_BUDGET

    def tick(self):
        self.visited += 1
        if self.visited > NODE_BUDGET or time.monotonic() > self.deadline:
            raise Budget()

    def box(self, node, in_doc):
        """The node's box in global logical coordinates, or None when it reports none."""
        e = extents(node)
        if not e or e[2] <= 0 or e[3] <= 0:
            return None
        sx, sy = (1, 1) if in_doc else self.ui_scale
        return (
            self.window["x"] + (e[0] - self.origin[0]) * sx,
            self.window["y"] + (e[1] - self.origin[1]) * sy,
            e[2] * sx,
            e[3] * sy,
        )

    def children(self, node, in_doc, within):
        """Showing children whose box meets `within` (or that report none), in document order."""
        for i in range(safe(node.get_child_count, 0)):
            child = safe(lambda: node.get_child_at_index(i))
            if child is None:
                continue
            self.tick()
            states = safe(child.get_state_set)
            if states is None or not states.contains(S.SHOWING):
                continue
            child_doc = in_doc or safe(child.get_role) in DOCUMENT_ROLES
            box = self.box(child, child_doc)
            if box is not None and not intersects(box, within):
                continue
            yield child, child_doc, box

    def element_at(self, node, in_doc, point):
        """The deepest showing node whose box holds the point, topmost (last) sibling first."""
        probe = (point["x"], point["y"], 1, 1)
        kids = list(self.children(node, in_doc, probe))
        for child, child_doc, box in reversed(kids):
            hit = self.element_at(child, child_doc, point)
            if hit:
                return hit
            if box is not None:
                return child, child_doc, box
        return None

    def text_in(self, node, in_doc, rect, out, parent_text=""):
        for child, child_doc, box in self.children(node, in_doc, rect):
            t = own_text(child)
            if t and self.clip and box is not None and not inside(box, rect):
                t = self.clipped(child, child_doc, box, rect, t)
            if t and t != parent_text:  # Chromium repeats a node's text in its inline text child
                out.append(t)
            self.text_in(child, child_doc, rect, out, t or parent_text)

    def clipped(self, node, in_doc, box, rect, whole):
        """
        The part of a node's text inside the rect: from the character at its
        top-left to the one at its bottom-right (corners clamped to the node), in
        reading order. All of it, flagged partial, when the app can't say.
        (Atspi.Text.get_bounded_ranges would be exact but crashes libatspi.)
        """
        sx, sy = (1, 1) if in_doc else self.ui_scale
        raw = lambda gx, gy: (
            int(self.origin[0] + (gx - self.window["x"]) / sx),
            int(self.origin[1] + (gy - self.window["y"]) / sy),
        )
        left, top = max(rect[0], box[0]), max(rect[1], box[1])
        right, bottom = min(rect[0] + rect[2], box[0] + box[2]) - 1, min(rect[1] + rect[3], box[1] + box[3]) - 1
        offset = lambda gx, gy: safe(lambda: Atspi.Text.get_offset_at_point(node, *raw(gx, gy), Atspi.CoordType.WINDOW), -1)
        start, end = offset(left, top), offset(right, bottom)
        if start < 0 or end < 0 or end < start:
            self.partial = True
            return whole
        text = safe(lambda: Atspi.Text.get_text(node, start, end + 1), "") or ""
        return " ".join(text.replace(OBJECT_CHAR, " ").split())

    def url(self):
        """The URL of the top-level showing web document, if the app exposes one."""
        stack = [self.frame]
        while stack:
            node = stack.pop()
            for i in range(safe(node.get_child_count, 0)):
                child = safe(lambda: node.get_child_at_index(i))
                if child is None:
                    continue
                self.tick()
                states = safe(child.get_state_set)
                if states is None or not states.contains(S.SHOWING):
                    continue
                if safe(child.get_role) in DOCUMENT_ROLES:
                    # Firefox calls it DocURL, Chromium URI.
                    url = safe(lambda: Atspi.Document.get_document_attribute_value(child, "DocURL")) or safe(
                        lambda: Atspi.Document.get_document_attribute_value(child, "URI")
                    )
                    if url:
                        return url
                    continue  # no URL; don't look inside the page for nested frames
                stack.append(child)
        return None


def safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def extents(node):
    comp = safe(node.get_component_iface)
    e = comp and safe(lambda: comp.get_extents(Atspi.CoordType.WINDOW))
    return (e.x, e.y, e.width, e.height) if e else None


def intersects(a, b):
    return a[0] < b[0] + b[2] and b[0] < a[0] + a[2] and a[1] < b[1] + b[3] and b[1] < a[1] + a[3]


def inside(a, b):
    return a[0] >= b[0] and a[1] >= b[1] and a[0] + a[2] <= b[0] + b[2] and a[1] + a[3] <= b[1] + b[3]


def own_text(node):
    """Text the node holds itself; children's text comes from the children."""
    if not safe(node.get_text_iface):
        return ""
    content = safe(lambda: Atspi.Text.get_text(node, 0, Atspi.Text.get_character_count(node)), "") or ""
    return " ".join(content.replace(OBJECT_CHAR, " ").split())


def find_frame(req):
    desktop = Atspi.get_desktop(0)
    for i in range(desktop.get_child_count()):
        app = safe(lambda: desktop.get_child_at_index(i))
        if app is None or safe(app.get_process_id) != req["pid"]:
            continue
        frames = [f for f in (safe(lambda: app.get_child_at_index(j)) for j in range(safe(app.get_child_count, 0))) if f]
        frames = [f for f in frames if safe(f.get_role) in FRAME_ROLES] or frames
        for f in frames:
            if safe(f.get_name) == req["title"]:
                return f
        for f in frames:
            states = safe(f.get_state_set)
            if states and states.contains(S.ACTIVE):
                return f
        return frames[0] if frames else None
    return None


def read(frame, req, result):
    tree = Tree(frame, req["window"])
    tree.clip = bool(req.get("clip"))
    try:
        result["url"] = tree.url()
        if req.get("point"):
            hit = tree.element_at(frame, False, req["point"])
            if hit:
                node, _, (x, y, w, h) = hit
                result["element"] = {
                    "role": safe(node.get_role_name, "") or "",
                    "name": safe(node.get_name, "") or "",
                    "text": own_text(node),
                    "x": round(x),
                    "y": round(y),
                    "width": round(w),
                    "height": round(h),
                }
        if req.get("rect") and req.get("text"):
            r = req["rect"]
            out = []
            try:
                tree.text_in(frame, False, (r["x"], r["y"], r["width"], r["height"]), out)
            finally:
                result["text"] = "\n".join(out)
                if tree.partial:
                    result["partial"] = True
    except Budget:
        result["truncated"] = True


def main():
    req = json.loads(sys.argv[1])
    Atspi.set_timeout(1000, 3000)
    frame = find_frame(req)
    result = {"found": frame is not None, "url": None, "element": None, "text": None}
    if frame is None:
        print(json.dumps(result))
        return
    # Chromium builds its tree only once an AT asks for attributes, and until then
    # reports null children, which libatspi caches: ask, then re-read if empty.
    safe(frame.get_attributes)
    read(frame, req, result)
    if not (result["url"] or result["element"] or result["text"]):
        time.sleep(0.5)
        safe(frame.clear_cache)
        read(frame, req, result)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
