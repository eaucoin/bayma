# Runs inside GIMP, through its Python batch interpreter, and serves one
# persistent Python namespace to clients on a Unix socket. Each request is a
# JSON line {"code": ...}; each reply is a JSON line with the cell's printed
# output and either the repr of its trailing expression or its traceback.
# {"quit": true} ends the bridge, and GIMP with it.

import ast
import contextlib
import io
import json
import os
import socket
import traceback

import gi

gi.require_version("Gimp", "3.0")
gi.require_version("Gegl", "0.4")
from gi.repository import Gegl, Gimp, Gio, GLib  # noqa: E402

namespace = {"__name__": "__gimp__", "Gimp": Gimp, "Gegl": Gegl, "Gio": Gio, "GLib": GLib}


def run_cell(code, printed):
    tree = ast.parse(code, "<cell>", "exec")
    trailing = tree.body.pop() if tree.body and isinstance(tree.body[-1], ast.Expr) else None
    with contextlib.redirect_stdout(printed):
        exec(compile(tree, "<cell>", "exec"), namespace)
        value = None
        if trailing is not None:
            value = eval(compile(ast.Expression(trailing.value), "<cell>", "eval"), namespace)
    return None if value is None else repr(value)


socket_path = os.environ["BAYMA_GIMP_SOCKET"]
with contextlib.suppress(FileNotFoundError):
    os.unlink(socket_path)
server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
server.bind(socket_path)
server.listen()
serving = True
while serving:
    connection, _ = server.accept()
    with connection, connection.makefile("rwb") as stream:
        for line in stream:
            request = json.loads(line)
            if request.get("quit"):
                serving = False
                break
            printed = io.StringIO()
            try:
                result = run_cell(request["code"], printed)
                reply = {"stdout": printed.getvalue(), "result": result}
            except Exception:
                reply = {"stdout": printed.getvalue(), "error": traceback.format_exc()}
            stream.write(json.dumps(reply).encode() + b"\n")
            stream.flush()
server.close()
os.unlink(socket_path)
