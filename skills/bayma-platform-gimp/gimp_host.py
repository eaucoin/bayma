"""Headless GIMP, driven from a bayma Python session through bridge.py.

    gimp = GimpHost()          # starts GIMP with the bridge
    gimp("image = Gimp.Image.new(640, 480, Gimp.ImageBaseType.RGB)")
    gimp("image.get_width()")  # '640', the repr of the trailing expression
    gimp.close()
"""

import json
import os
import socket
import subprocess
import time

SKILL = os.path.dirname(os.path.abspath(__file__))
INSTALL = os.path.join(SKILL, "gimp")


class GimpError(Exception):
    """GIMP could not start, or a cell raised inside it (the traceback)."""


class GimpHost:
    def __init__(self, startup_timeout=300):
        # The command that installs GIMP, with the Bun bayma runs sessions on.
        install = f"{os.environ.get('BAYMA_BUN_BIN', 'bun')} {os.path.join(SKILL, 'install.ts')}"
        try:
            with open(os.path.join(INSTALL, "env.json")) as file:
                launch = json.load(file)
            with open(os.path.join(INSTALL, "fonts.json")) as file:
                installed_fonts = json.load(file)
        except FileNotFoundError:
            raise GimpError(f"GIMP is not installed; install it: {install}") from None
        with open(os.path.join(SKILL, "fonts.json")) as file:
            if json.load(file) != installed_fonts:
                raise GimpError(f"fonts.json changed since GIMP was installed; install it again: {install}")

        run = os.path.join(INSTALL, "run")
        os.makedirs(run, exist_ok=True)
        self.socket_path = os.path.join(run, "bridge.sock")
        self.log_path = os.path.join(run, "gimp.log")
        bridge = os.path.join(SKILL, "bridge.py")
        with open(self.log_path, "wb") as log:
            self.process = subprocess.Popen(
                [launch["command"], "-i", "--batch-interpreter=python-fu-eval",
                 "-b", f"exec(open({bridge!r}).read())", "--quit"],
                cwd=launch["cwd"],
                env={**os.environ, **launch["env"], "BAYMA_GIMP_SOCKET": self.socket_path},
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
            )
        deadline = time.monotonic() + startup_timeout
        while True:
            if self.process.poll() is not None:
                raise GimpError(f"GIMP exited while starting; see {self.log_path}")
            self.connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                self.connection.connect(self.socket_path)
                break
            except (FileNotFoundError, ConnectionRefusedError):
                self.connection.close()
                if time.monotonic() > deadline:
                    self.process.kill()
                    raise GimpError(f"GIMP did not start in {startup_timeout}s; see {self.log_path}")
                time.sleep(0.2)
        self.stream = self.connection.makefile("rwb")

    def __call__(self, code):
        """Runs code in GIMP; prints what it printed, returns its value's repr."""
        self.stream.write(json.dumps({"code": code}).encode() + b"\n")
        self.stream.flush()
        reply = json.loads(self.stream.readline())
        if reply["stdout"]:
            print(reply["stdout"], end="")
        if "error" in reply:
            raise GimpError(reply["error"])
        return reply["result"]

    def close(self):
        """Ends GIMP."""
        self.stream.write(json.dumps({"quit": True}).encode() + b"\n")
        self.stream.flush()
        self.connection.close()
        self.process.wait(timeout=60)
