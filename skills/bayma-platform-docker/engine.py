"""The Docker Engine this skill drives, kept in .engine/engine.json.

The skill pins its packages in its own folder, but not the Engine: that is a
daemon its machine runs, and installing one takes root. So the skill is
connected to an Engine once, and every session after uses that one:

  python -I engine.py        install the packages, find an Engine that
                             answers here, and keep it
  python -I engine.py HOST   install the packages, and keep HOST: a socket,
                             unix:///path/to/docker.sock; another machine over
                             its ssh, ssh://user@host; or tcp://host:2376,
                             with --tls naming the directory of its ca.pem,
                             cert.pem, and key.pem
"""

from __future__ import annotations

import argparse
import atexit
import contextlib
import importlib
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
from pathlib import Path
from typing import TYPE_CHECKING
from urllib.parse import urlsplit

if TYPE_CHECKING:
    import docker

SKILL = Path(__file__).resolve().parent
PACKAGES = SKILL / "site-packages"
SAVED = SKILL / ".engine" / "engine.json"

# The skill's packages, ahead of any others an interpreter has.
if str(PACKAGES) not in sys.path:
    sys.path.insert(0, str(PACKAGES))


def _look_again() -> None:
    """Forgets what Python found in the skill's packages, or that they were
    missing, so that packages installed since are imported."""
    sys.path_importer_cache.pop(str(PACKAGES), None)
    importlib.invalidate_caches()


class SetupNeeded(RuntimeError):
    """What this skill lacks, ending with the one command that fixes it."""

    def __init__(self, reason: str) -> None:
        super().__init__(
            f"{reason}. Set this skill up: {sys.executable} -I {SKILL / 'engine.py'}"
        )


def install() -> None:
    """Installs the pinned packages into the skill's folder, and only them."""
    result = subprocess.run(
        [
            sys.executable,
            "-I",
            "-m",
            "pip",
            "install",
            "--quiet",
            "--disable-pip-version-check",
            "--require-hashes",
            "--no-deps",
            "--only-binary=:all:",
            "--upgrade",
            "--target",
            str(PACKAGES),
            "-r",
            str(SKILL / "requirements.txt"),
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"Installing the Docker SDK failed:\n{result.stderr.strip()}"
        )
    _look_again()


# Sockets that reach Engines over ssh, by host, for as long as this process
# runs, and what ssh last said when it failed for each.
_forwarded: dict[str, str] = {}
_ssh_failures: dict[str, str] = {}


def _alive(pid: int) -> bool:
    """Whether the process `pid` still runs."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        pass
    return True


def _through_ssh(host: str) -> str:
    """A socket here that reaches the Engine at `host`, an ssh:// URL, through
    this machine's ssh, as the docker command does: each connection runs
    `docker system dial-stdio` there. The SDK's own ssh:// needs paramiko,
    which is built for each platform, where this needs nothing installed."""
    if host in _forwarded:
        return _forwarded[host]
    target = urlsplit(host)
    command = [
        "ssh",
        "-o",
        "BatchMode=yes",
        *(["-p", str(target.port)] if target.port else []),
        *(["-l", target.username] if target.username else []),
        "--",
        target.hostname or "",
        "docker",
        "system",
        "dial-stdio",
    ]
    # A session can end without warning; the next one clears its sockets.
    for stale in Path(tempfile.gettempdir()).glob("bayma-docker-*-*"):
        pid = stale.name.split("-")[2]
        if pid.isdigit() and not _alive(int(pid)):
            shutil.rmtree(stale, ignore_errors=True)
    directory = tempfile.mkdtemp(prefix=f"bayma-docker-{os.getpid()}-")
    atexit.register(shutil.rmtree, directory, ignore_errors=True)
    path = os.path.join(directory, "docker.sock")
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(path)
    listener.listen()

    def bridge(connection: socket.socket) -> None:
        with (
            connection,
            subprocess.Popen(
                command,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            ) as dialed,
        ):
            assert dialed.stdin and dialed.stdout and dialed.stderr

            def send() -> None:
                # Either side may end first: that ends the connection.
                with contextlib.suppress(OSError):
                    while chunk := connection.recv(65536):
                        dialed.stdin.write(chunk)
                        dialed.stdin.flush()
                    dialed.stdin.close()

            threading.Thread(target=send, daemon=True).start()
            with contextlib.suppress(OSError):
                while chunk := dialed.stdout.read1(65536):
                    connection.sendall(chunk)
            # What ssh said is kept before the client learns the connection
            # ended, so its error can say why.
            if dialed.wait() != 0:
                _ssh_failures[host] = dialed.stderr.read().decode().strip()
            # Wakes the other direction's recv and tells the client the
            # connection ended; closing alone does neither.
            with contextlib.suppress(OSError):
                connection.shutdown(socket.SHUT_RDWR)

    def serve() -> None:
        while True:
            connection, _ = listener.accept()
            threading.Thread(target=bridge, args=(connection,), daemon=True).start()

    threading.Thread(target=serve, daemon=True).start()
    _forwarded[host] = f"unix://{path}"
    return _forwarded[host]


def _open(engine: dict[str, str]) -> docker.DockerClient:
    """A client for `engine`, once it has answered."""
    import docker

    tls = None
    if engine.get("tls"):
        certs = Path(engine["tls"])
        tls = docker.tls.TLSConfig(
            client_cert=(str(certs / "cert.pem"), str(certs / "key.pem")),
            ca_cert=str(certs / "ca.pem"),
            verify=True,
        )
    host = engine["host"]
    over_ssh = host.startswith("ssh://")
    _ssh_failures.pop(host, None)
    try:
        client = docker.DockerClient(
            base_url=_through_ssh(host) if over_ssh else host, tls=tls
        )
        client.ping()
    except docker.errors.DockerException as error:
        if over_ssh and _ssh_failures.get(host):
            raise docker.errors.DockerException(
                f"ssh said: {_ssh_failures[host]}"
            ) from error
        raise
    return client


def connect() -> docker.DockerClient:
    """A client for the Engine this skill keeps."""
    _look_again()
    try:
        import docker
    except ImportError:
        raise SetupNeeded("The Docker SDK is not installed in this skill") from None
    if not SAVED.exists():
        raise SetupNeeded("This skill is connected to no Docker Engine")
    engine = json.loads(SAVED.read_text())
    try:
        return _open(engine)
    except docker.errors.DockerException as error:
        raise SetupNeeded(
            f"The Docker Engine at {engine['host']} did not answer ({error})"
        ) from None


def _candidates() -> list[str]:
    """Where an Engine is likely to answer here, most specific first."""
    import docker

    hosts = [os.environ.get("DOCKER_HOST", "")]
    with contextlib.suppress(docker.errors.DockerException):
        hosts.append(docker.ContextAPI.get_current_context().Host or "")
    runtime = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    home = Path.home()
    for path in (
        Path(runtime) / "docker.sock",  # rootless Docker
        home / ".docker" / "run" / "docker.sock",  # Docker Desktop
        home / ".colima" / "default" / "docker.sock",
        home / ".orbstack" / "run" / "docker.sock",
        Path("/var/run/docker.sock"),
    ):
        hosts.append(f"unix://{path}")
    return [host for host in dict.fromkeys(hosts) if host]


def _nothing_answered() -> str:
    """Why no Engine answered here, and what would make one."""
    system = Path("/var/run/docker.sock")
    if system.exists() and not os.access(system, os.R_OK | os.W_OK):
        return (
            "A Docker Engine runs here, but only root and the docker group may use "
            "it: add yourself, with sudo usermod -aG docker $USER, and sign in again"
        )
    if sys.platform == "darwin":
        return "No Docker Engine runs here: start one, such as Docker Desktop"
    if Path("/etc/debian_version").exists():
        return (
            "No Docker Engine runs here: install one, with sudo apt-get install -y "
            "docker.io && sudo usermod -aG docker $USER, and sign in again"
        )
    return (
        "No Docker Engine runs here: install one, as "
        "https://docs.docker.com/engine/install/ describes"
    )


def _keep(engine: dict[str, str]) -> str:
    """Keeps `engine` for the skill's sessions, once it has answered."""
    client = _open(engine)
    version = client.version()
    SAVED.parent.mkdir(mode=0o700, exist_ok=True)
    SAVED.write_text(json.dumps(engine, indent=2) + "\n")
    return (
        f"Connected to Docker Engine {version['Version']} "
        f"({version['Os']}/{version['Arch']}) at {engine['host']}"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("host", nargs="?", help="the Engine to keep")
    parser.add_argument("--tls", help="the directory of ca.pem, cert.pem, and key.pem")
    arguments = parser.parse_args()
    install()
    import docker

    if arguments.host:
        engine = {"host": arguments.host}
        if arguments.tls:
            engine["tls"] = str(Path(arguments.tls).resolve())
        try:
            print(_keep(engine))
        except docker.errors.DockerException as error:
            sys.exit(f"The Docker Engine at {arguments.host} did not answer: {error}")
        return
    for host in _candidates():
        try:
            print(_keep({"host": host}))
            return
        except docker.errors.DockerException:
            continue
    sys.exit(
        f"{_nothing_answered()}; or keep one elsewhere: "
        f"{sys.executable} -I {SKILL / 'engine.py'} ssh://user@host"
    )


if __name__ == "__main__":
    main()
