from __future__ import annotations

import os
import signal
import subprocess
import tempfile
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

DEFAULT_TOOL_TIMEOUT_SECONDS = 120.0
DEFAULT_OUTPUT_LIMIT_BYTES = 64 * 1024

# The REPL's own interpreter may start with these pointing at its bundled
# standard library (bayma's Python does); a child interpreter such as the
# toolbelt environment's inherits them and loads the wrong stdlib.
INTERPRETER_REDIRECTS = ("PYTHONHOME", "PYTHONPATH")


@dataclass(frozen=True, slots=True)
class PythonToolResult:
    argv: tuple[str, ...]
    cwd: Path
    returncode: int
    stdout: str
    stderr: str
    timed_out: bool

    @property
    def successful(self) -> bool:
        return not self.timed_out and self.returncode == 0


def read_bounded_output(handle: BinaryIO, limit_bytes: int) -> str:
    handle.flush()
    handle.seek(0, os.SEEK_END)
    size = handle.tell()
    handle.seek(0)
    if size <= limit_bytes:
        return handle.read().decode("utf-8", errors="replace")

    head_size = limit_bytes // 2
    tail_size = limit_bytes - head_size
    head = handle.read(head_size)
    handle.seek(-tail_size, os.SEEK_END)
    tail = handle.read(tail_size)
    omitted = size - limit_bytes
    marker = f"\n... {omitted} output bytes omitted ...\n".encode()
    return (head + marker + tail).decode("utf-8", errors="replace")


def terminate_process(
    process: subprocess.Popen[bytes], *, grace_seconds: float = 0.0
) -> int:
    if process.poll() is None:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGTERM)
        else:
            process.terminate()
        if grace_seconds > 0:
            try:
                return process.wait(timeout=grace_seconds)
            except subprocess.TimeoutExpired:
                pass
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGKILL)
        else:
            process.kill()
    return process.wait()


def run_bounded_command(
    argv: Sequence[str | Path],
    *,
    cwd: Path | str,
    timeout_seconds: float = DEFAULT_TOOL_TIMEOUT_SECONDS,
    output_limit_bytes: int = DEFAULT_OUTPUT_LIMIT_BYTES,
    stdin: str | bytes | None = None,
    environment: Mapping[str, str] | None = None,
) -> PythonToolResult:
    if timeout_seconds <= 0:
        raise ValueError("timeout_seconds must be positive")
    if output_limit_bytes < 1024:
        raise ValueError("output_limit_bytes must be at least 1024")

    normalized_argv = tuple(str(argument) for argument in argv)
    if not normalized_argv:
        raise ValueError("A tool command is required")
    working_directory = Path(cwd).expanduser().resolve()
    if not working_directory.is_dir():
        raise RuntimeError(f"Tool working directory is unavailable: {working_directory}")

    child_environment = {
        name: value
        for name, value in os.environ.items()
        if name not in INTERPRETER_REDIRECTS
    }
    child_environment["PYTHONNOUSERSITE"] = "1"
    if environment:
        child_environment.update(environment)
    input_bytes = stdin.encode() if isinstance(stdin, str) else stdin
    timed_out = False
    with (
        tempfile.TemporaryFile(mode="w+b") as stdout_handle,
        tempfile.TemporaryFile(mode="w+b") as stderr_handle,
    ):
        process = subprocess.Popen(
            normalized_argv,
            cwd=working_directory,
            env=child_environment,
            stdin=subprocess.PIPE if input_bytes is not None else subprocess.DEVNULL,
            stdout=stdout_handle,
            stderr=stderr_handle,
            start_new_session=os.name == "posix",
        )
        try:
            process.communicate(input=input_bytes, timeout=timeout_seconds)
            returncode = process.returncode
        except subprocess.TimeoutExpired:
            timed_out = True
            returncode = terminate_process(process)

        return PythonToolResult(
            argv=normalized_argv,
            cwd=working_directory,
            returncode=returncode,
            stdout=read_bounded_output(stdout_handle, output_limit_bytes),
            stderr=read_bounded_output(stderr_handle, output_limit_bytes),
            timed_out=timed_out,
        )


__all__ = [
    "DEFAULT_OUTPUT_LIMIT_BYTES",
    "DEFAULT_TOOL_TIMEOUT_SECONDS",
    "INTERPRETER_REDIRECTS",
    "PythonToolResult",
    "read_bounded_output",
    "run_bounded_command",
    "terminate_process",
]
