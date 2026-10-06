"""The Hetzner Cloud projects this skill drives, kept in .projects/NAME.json.

A Hetzner Cloud API token belongs to one project, and reads it, or reads and
writes it; nothing finer. So the skill keeps a token per project, under a
name of your choosing, readable only by you. Its packages are installed by
bayma's Python, which imports them; a token is typed in a terminal, by any
Python 3, as saving one needs nothing but the standard library:

  python -I projects.py              in a bayma Python session: install the
                                     packages, and list the saved projects
  python3 -I projects.py add NAME    in a terminal: ask for a project's token,
                                     without echoing it, check it with
                                     Hetzner, and save it as NAME
  python3 -I projects.py remove NAME in a terminal: forget NAME
"""

from __future__ import annotations

import argparse
import getpass
import importlib
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import hcloud

SKILL = Path(__file__).resolve().parent
PACKAGES = SKILL / "site-packages"
SAVED = SKILL / ".projects"
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")
API = "https://api.hetzner.cloud/v1"
USER_AGENT = "bayma-platform-hcloud"

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


def _install_needed(reason: str) -> SetupNeeded:
    """`reason`, and the command, run by this bayma session's Python, that
    installs the packages."""
    return SetupNeeded(
        f"{reason}. Set this skill up: {sys.executable} -I {SKILL / 'projects.py'}"
    )


def _project_needed(reason: str, name: str = "NAME") -> SetupNeeded:
    """`reason`, and the command that saves a project, which its user runs in
    a terminal, so that the token stays out of every REPL session."""
    return SetupNeeded(
        f"{reason}. Save one, in a terminal: "
        f"python3 -I {SKILL / 'projects.py'} add {name}"
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
            f"Installing the Hetzner Cloud SDK failed:\n{result.stderr.strip()}"
        )
    _look_again()


def list_projects() -> list[str]:
    """The names of the saved projects."""
    if not SAVED.exists():
        return []
    return sorted(path.stem for path in SAVED.glob("*.json"))


def _token(name: str | None) -> str:
    """The token of the saved project `name`, or with no name, of the only
    one saved."""
    names = list_projects()
    if name is None:
        if not names:
            raise _project_needed("This skill has no saved Hetzner Cloud project")
        if len(names) > 1:
            raise RuntimeError(
                f"This skill has several saved projects; name one: {', '.join(names)}"
            )
        name = names[0]
    if name not in names:
        has = f" (it has {', '.join(names)})" if names else ""
        raise _project_needed(f"This skill has no project named {name}{has}", name)
    return json.loads((SAVED / f"{name}.json").read_text())["token"]


def connect(name: str | None = None) -> hcloud.Client:
    """A client for the saved project `name`, or with no name, the only one
    saved."""
    _look_again()
    try:
        import hcloud
    except ImportError:
        raise _install_needed(
            "The Hetzner Cloud SDK is not installed in this skill"
        ) from None
    return hcloud.Client(token=_token(name), application_name=USER_AGENT)


def _ask_token(name: str) -> str:
    """A line from the terminal, not echoed; or from stdin when it is not one."""
    if not sys.stdin.isatty():
        return sys.stdin.readline().strip()
    return getpass.getpass(f"API token of the Hetzner Cloud project {name}: ").strip()


def _locations(token: str) -> list[str]:
    """The names of the locations the project of `token` offers, as Hetzner
    answers them to the token: the call any token may make."""
    request = urllib.request.Request(
        f"{API}/locations",
        headers={"Authorization": f"Bearer {token}", "User-Agent": USER_AGENT},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            answer = json.load(response)
    except urllib.error.HTTPError as error:
        try:
            said = json.load(error)["error"]
            reason = f"{said['message']} ({said['code']})"
        except (ValueError, KeyError, TypeError):
            reason = f"HTTP {error.code}"
        raise RuntimeError(f"Hetzner Cloud refused the token: {reason}") from None
    except urllib.error.URLError as error:
        raise RuntimeError(f"Hetzner Cloud did not answer: {error.reason}") from None
    return [location["name"] for location in answer["locations"]]


def add(name: str) -> str:
    """Asks for the token of a project, checks it with Hetzner, and saves it
    as `name`."""
    if not NAME.match(name):
        raise ValueError(f'A project name is letters, digits, "-", and "_": {name}')
    token = _ask_token(name)
    if not token:
        raise ValueError("No token was given")
    locations = _locations(token)
    SAVED.mkdir(mode=0o700, exist_ok=True)
    SAVED.chmod(0o700)
    path = SAVED / f"{name}.json"
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as saved:
        saved.write(json.dumps({"token": token}, indent=2) + "\n")
    path.chmod(0o600)
    return (
        f"Saved as {name}: the token reads the project, which offers "
        f"{', '.join(locations)}"
    )


def remove(name: str) -> str:
    """Forgets `name`."""
    if name not in list_projects():
        raise RuntimeError(f"This skill has no project named {name}")
    (SAVED / f"{name}.json").unlink()
    return f"Removed {name}"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("command", nargs="?", choices=["add", "remove"])
    parser.add_argument("name", nargs="?")
    arguments = parser.parse_args()
    if arguments.command and not arguments.name:
        parser.error(f"{arguments.command} needs a NAME")
    try:
        if arguments.command == "add":
            print(add(arguments.name))
        elif arguments.command == "remove":
            print(remove(arguments.name))
        else:
            install()
            names = list_projects()
            print("\n".join(names) if names else "No saved projects")
    except (RuntimeError, ValueError) as error:
        sys.exit(str(error))


if __name__ == "__main__":
    main()
