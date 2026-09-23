"""Headless Blender, driven from a bayma Python session through bridge.py.

    blender = BlenderHost()           # starts Blender with the bridge
    blender("bpy.ops.mesh.primitive_monkey_add()")
    blender("[o.name for o in bpy.data.objects]")   # the trailing value's repr
    blender.close()

A long animation renders apart from the session, so it outlives it:

    render = render_detached("/path/scene.blend")   # its frames, as the .blend names them
    encode("/path/frames", "/path/film.mp4", fps=24)
"""

import json
import os
import socket
import subprocess
import time

SKILL = os.path.dirname(os.path.abspath(__file__))
INSTALL = os.path.join(SKILL, "blender")


class BlenderError(Exception):
    """Blender could not start, or a cell raised in it (the traceback)."""


def _launch():
    install = f"{os.environ.get('BAYMA_BUN_BIN', 'bun')} {os.path.join(SKILL, 'install.ts')}"
    try:
        with open(os.path.join(INSTALL, "env.json")) as file:
            return json.load(file)
    except FileNotFoundError:
        raise BlenderError(f"Blender is not installed; install it: {install}") from None


class BlenderHost:
    """Headless Blender, which keeps one Python namespace between cells."""

    def __init__(self, startup_timeout=120):
        launch = _launch()
        run = os.path.join(INSTALL, "run")
        os.makedirs(run, exist_ok=True)
        self.socket_path = os.path.join(run, f"bridge-{os.getpid()}.sock")
        self.log_path = os.path.join(run, "blender.log")
        with open(self.log_path, "wb") as log:
            self.process = subprocess.Popen(
                [launch["command"], "-b", "--factory-startup", "--python", os.path.join(SKILL, "bridge.py")],
                env={**os.environ, **launch["env"], "BAYMA_BLENDER_SOCKET": self.socket_path},
                stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + startup_timeout
        while True:
            if self.process.poll() is not None:
                raise BlenderError(f"Blender exited while starting; see {self.log_path}")
            self.connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                self.connection.connect(self.socket_path)
                break
            except (FileNotFoundError, ConnectionRefusedError):
                self.connection.close()
                if time.monotonic() > deadline:
                    self.process.kill()
                    raise BlenderError(f"Blender did not start in {startup_timeout}s; see {self.log_path}")
                time.sleep(0.2)
        self.stream = self.connection.makefile("rwb")

    def __call__(self, code):
        """Runs Python in Blender; prints what it printed, returns its value's repr."""
        self.stream.write(json.dumps({"code": code}).encode() + b"\n")
        self.stream.flush()
        reply = json.loads(self.stream.readline())
        if reply["stdout"]:
            print(reply["stdout"], end="")
        if "error" in reply:
            raise BlenderError(reply["error"])
        return reply["result"]

    def close(self):
        """Ends Blender."""
        self.stream.write(json.dumps({"quit": True}).encode() + b"\n")
        self.stream.flush()
        self.connection.close()
        self.process.wait(timeout=60)


def render_detached(blend, log=None):
    """Renders the .blend's animation in a Blender of its own, which outlives
    this session; frames already rendered are kept if the .blend says so
    (render.use_overwrite False). Returns the process and its log."""
    launch = _launch()
    log = log or os.path.splitext(blend)[0] + "-render.log"
    with open(log, "wb") as output:
        process = subprocess.Popen(
            [launch["command"], "-b", blend, "-a"],
            env={**os.environ, **launch["env"]},
            stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
            start_new_session=True)
    return process, log


def encode(frames_dir, output, fps=24):
    """Encodes a folder of numbered PNG frames into an H.264 MP4, with
    Blender's own FFmpeg."""
    launch = _launch()
    result = subprocess.run(
        [launch["command"], "-b", "--factory-startup", "--python", os.path.join(SKILL, "encode.py"),
         "--", os.path.abspath(frames_dir), os.path.abspath(output), str(fps)],
        env={**os.environ, **launch["env"]}, capture_output=True, text=True)
    if result.returncode != 0 or "ENCODED" not in result.stdout:
        raise BlenderError(f"encoding failed:\n{result.stdout[-2000:]}{result.stderr[-2000:]}")
    return output
