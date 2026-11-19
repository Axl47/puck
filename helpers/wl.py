#!/usr/bin/env python3
"""Minimal Wayland client for Puck's pointer: no dependencies beyond the stdlib.

  wl.py position              where the pointer is: {"output": name, "x": local, "y": local}
  wl.py act '<json ops>'      pointer input through wlr virtual-pointer

`position` maps a transparent overlay on every output for a moment and reads
the wl_pointer.enter the compositor sends to the one under the cursor (it needs
a buffer, so a shared-memory fd, which Node can't pass over a socket).

`act` ops, run in order on one virtual pointer:
  {"op": "move", "x": x, "y": y, "width": w, "height": h}   integers, relative to the
      bounding box of all outputs (w x h), which is how Umbriel maps absolute motion
  {"op": "button", "button": "left"|"right"|"middle", "state": "press"|"release"}
  {"op": "scroll", "dx": steps, "dy": steps}
  {"op": "sleep", "ms": n}
"""
import json
import mmap
import os
import select
import socket
import struct
import sys
import time

BUTTONS = {"left": 0x110, "right": 0x111, "middle": 0x112}
AXIS_STEP = 15.0  # wl_pointer axis units per wheel detent, as libinput reports


class Wayland:
    def __init__(self):
        path = os.path.join(os.environ["XDG_RUNTIME_DIR"], os.environ.get("WAYLAND_DISPLAY", "wayland-0"))
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(path)
        self.next_id = 2
        self.handlers = {}  # object id -> fn(opcode, payload)
        self.buf = b""
        self.globals = {}  # interface -> [(name, version)]
        self.registry = self.new(self.on_registry)
        self.send(1, 1, ("n", self.registry))  # wl_display.get_registry
        self.handlers[1] = self.on_display
        self.roundtrip()

    def new(self, handler=None):
        oid = self.next_id
        self.next_id += 1
        if handler:
            self.handlers[oid] = handler
        return oid

    def send(self, oid, opcode, *args, fd=None):
        body = b""
        for kind, value in args:
            if kind in ("u", "n", "o"):
                body += struct.pack("<I", value)
            elif kind == "i":
                body += struct.pack("<i", value)
            elif kind == "f":
                body += struct.pack("<i", int(round(value * 256)))
            elif kind == "s":
                raw = value.encode() + b"\0"
                body += struct.pack("<I", len(raw)) + raw + b"\0" * (-len(raw) % 4)
        msg = struct.pack("<II", oid, ((8 + len(body)) << 16) | opcode) + body
        if fd is None:
            self.sock.sendall(msg)
        else:
            self.sock.sendmsg([msg], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, struct.pack("i", fd))])

    def bind(self, interface, version, handler=None):
        found = self.globals.get(interface)
        if not found:
            raise SystemExit(f"compositor lacks {interface}")
        name, have = found[0]
        oid = self.new(handler)
        v = min(version, have)
        self.send(self.registry, 0, ("u", name), ("s", interface), ("u", v), ("n", oid))
        return oid, v

    def dispatch(self, timeout):
        """Reads and handles events for up to `timeout` seconds; False on timeout."""
        r, _, _ = select.select([self.sock], [], [], timeout)
        if not r:
            return False
        data = self.sock.recv(65536)
        if not data:
            raise SystemExit("compositor closed the connection")
        self.buf += data
        while len(self.buf) >= 8:
            oid, word = struct.unpack_from("<II", self.buf)
            size = word >> 16
            if len(self.buf) < size:
                break
            payload, self.buf = self.buf[8:size], self.buf[size:]
            handler = self.handlers.get(oid)
            if handler:
                handler(word & 0xFFFF, payload)
        return True

    def roundtrip(self):
        done = []
        cb = self.new(lambda op, p: done.append(True))
        self.send(1, 0, ("n", cb))  # wl_display.sync
        while not done:
            self.dispatch(5)

    def on_display(self, opcode, payload):
        if opcode == 0:  # error
            oid, code = struct.unpack_from("<II", payload)
            raise SystemExit(f"wayland error on object {oid} (code {code}): {string_at(payload, 8)}")

    def on_registry(self, opcode, payload):
        if opcode == 0:  # global
            name = struct.unpack_from("<I", payload)[0]
            interface = string_at(payload, 4)
            version = struct.unpack_from("<I", payload, 8 + padded(payload, 4))[0]
            self.globals.setdefault(interface, []).append((name, version))

    def outputs(self):
        """Binds every wl_output and returns {name: oid}."""
        named = {}
        for gname, version in self.globals.get("wl_output", []):
            oid = self.new()
            self.handlers[oid] = lambda op, p, oid=oid: named.__setitem__(string_at(p, 0), oid) if op == 4 else None
            self.send(self.registry, 0, ("u", gname), ("s", "wl_output"), ("u", min(version, 4)), ("n", oid))
        self.roundtrip()
        return named


def padded(payload, at):
    """Bytes a string argument at `at` occupies, length word included minus the word itself."""
    n = struct.unpack_from("<I", payload, at)[0]
    return n + (-n % 4)


def string_at(payload, at):
    n = struct.unpack_from("<I", payload, at)[0]
    return payload[at + 4 : at + 4 + n - 1].decode(errors="replace")


def position(wl):
    outputs = wl.outputs()
    compositor, _ = wl.bind("wl_compositor", 4)
    shm, _ = wl.bind("wl_shm", 1)
    layer_shell, _ = wl.bind("zwlr_layer_shell_v1", 1)
    viewporter, _ = wl.bind("wp_viewporter", 1)
    seat, _ = wl.bind("wl_seat", 5)

    # One transparent pixel, stretched over each output by a viewport.
    fd = os.memfd_create("puck-probe")
    os.ftruncate(fd, 4)
    pool = wl.new()
    wl.send(shm, 0, ("n", pool), ("i", 4), fd=fd)  # create_pool
    os.close(fd)

    found = {}
    surfaces = {}
    pointer = wl.new()

    def on_pointer(op, p):
        if op == 0:  # enter(serial, surface, x, y)
            _, surface, x, y = struct.unpack_from("<IIii", p)
            if surface in surfaces:
                found.update(output=surfaces[surface], x=x / 256, y=y / 256)

    wl.handlers[pointer] = on_pointer
    wl.send(seat, 0, ("n", pointer))  # get_pointer

    for name, output in outputs.items():
        surface = wl.new()
        wl.send(compositor, 0, ("n", surface))
        surfaces[surface] = name

        buffer = wl.new()
        wl.send(pool, 0, ("n", buffer), ("i", 0), ("i", 1), ("i", 1), ("i", 4), ("u", 0))  # argb8888
        viewport = wl.new()
        wl.send(viewporter, 1, ("n", viewport), ("o", surface))
        layer = wl.new()  # the server wants new ids in the order they're sent

        def on_layer(op, p, surface=surface, layer=layer, buffer=buffer, viewport=viewport):
            if op == 0:  # configure(serial, width, height); may come more than once
                serial, w, h = struct.unpack_from("<III", p)
                wl.send(layer, 6, ("u", serial))  # ack_configure
                wl.send(viewport, 2, ("i", w), ("i", h))  # set_destination
                wl.send(surface, 1, ("o", buffer), ("i", 0), ("i", 0))  # attach
                wl.send(surface, 6)  # commit

        wl.handlers[layer] = on_layer
        # overlay layer, all four edges anchored, size 0x0 = the whole output
        wl.send(layer_shell, 0, ("n", layer), ("o", surface), ("o", output), ("u", 3), ("s", "puck-pointer-probe"))
        wl.send(layer, 1, ("u", 15))  # set_anchor
        wl.send(layer, 2, ("i", -1))  # exclusive zone: ignore panels
        wl.send(surface, 6)

    deadline = time.monotonic() + 0.5
    while not found and time.monotonic() < deadline:
        wl.dispatch(deadline - time.monotonic())
    if not found:
        raise SystemExit("the compositor didn't report the pointer over any output")
    return found


def act(wl, ops):
    seat, _ = wl.bind("wl_seat", 1)
    manager, _ = wl.bind("zwlr_virtual_pointer_manager_v1", 1)
    vp = wl.new()
    wl.send(manager, 0, ("o", seat), ("n", vp))  # create_virtual_pointer
    now = lambda: int(time.monotonic() * 1000) & 0xFFFFFFFF
    for op in ops:
        kind = op["op"]
        if kind == "sleep":
            time.sleep(op["ms"] / 1000)
            continue
        if kind == "move":
            # Umbriel maps absolute motion over the bounding box of all outputs, whatever output the pointer is bound to.
            wl.send(vp, 1, ("u", now()), ("u", op["x"]), ("u", op["y"]), ("u", op["width"]), ("u", op["height"]))
        elif kind == "button":
            wl.send(vp, 2, ("u", now()), ("u", BUTTONS[op["button"]]), ("u", 1 if op["state"] == "press" else 0))
        elif kind == "scroll":
            # One detent per frame, as a real wheel sends them; apps drop or cap one large step.
            for axis, steps in ((0, op.get("dy", 0)), (1, op.get("dx", 0))):
                for _ in range(abs(steps)):
                    sign = 1 if steps > 0 else -1
                    wl.send(vp, 5, ("u", 0))  # axis_source: wheel
                    wl.send(vp, 7, ("u", now()), ("u", axis), ("f", sign * AXIS_STEP), ("i", sign))
                    wl.send(vp, 4)
                    wl.roundtrip()
                    time.sleep(0.02)
            continue
        wl.send(vp, 4)  # frame
        wl.roundtrip()
    wl.send(vp, 8)  # destroy
    wl.roundtrip()


def main():
    wl = Wayland()
    if sys.argv[1:2] == ["position"]:
        print(json.dumps(position(wl)))
    elif sys.argv[1:2] == ["act"] and len(sys.argv) == 3:
        act(wl, json.loads(sys.argv[2]))
        print("{}")
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
