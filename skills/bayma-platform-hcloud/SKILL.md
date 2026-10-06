---
name: bayma-platform-hcloud
description: Inspect the source code of and execute code from the installed `hcloud` Python package, Hetzner Cloud's SDK; drive Hetzner Cloud projects with API tokens kept in this skill's folder.
---

# Hetzner Cloud Platform

This skill shows you where to find the relevant packages to reference when writing correct source code or interactively executing code that interacts with the platform appropriately. The skill owns its packages and the API tokens of the Hetzner Cloud projects it drives; both live in its own folder, `<skill>` below.

## Reference Materials

The reference materials for this skill are the installed package source and documentation under:

- `<skill>/site-packages/hcloud/**`: `hcloud.Client`, with a client per resource, such as `servers`, `networks`, `firewalls`, `ssh_keys`, `volumes`, `load_balancers`, and `actions`
- https://hcloud-python.readthedocs.io/en/stable/: the SDK's documentation
- https://docs.hetzner.cloud/reference/cloud: the Hetzner Cloud API it speaks

If these materials are missing, set the skill up, in a bayma Python session whose `cwd` is `<skill>`:

```python
import subprocess, sys

ran = subprocess.run([sys.executable, "-I", "projects.py"], capture_output=True, text=True)
ran.stdout + ran.stderr
```

## Projects

A Hetzner Cloud API token belongs to one project, made in the Hetzner Console under the project's Security, API tokens. It reads the project, or reads and writes it: there is nothing finer, and no expiry, so a token that writes can delete anything in its project. Each saved project is a name and its token; saving one asks for the token without echoing it, so it stays out of shell and REPL session history, and checks it with Hetzner first. Saving needs nothing but Python 3's standard library, so any `python3` does it. In a terminal, in `<skill>`:

```sh
python3 -I projects.py add NAME     # ask for a project's token, check it, and save it as NAME
python3 -I projects.py remove NAME  # forget NAME
```

Setting the skill up, as above, lists the saved projects.

A server's metadata service hands its cloud-init user data to anything on the server that asks, so user data is no place for a token or other secret.

## Interactive Quickstart

In a bayma Python session whose `cwd` is `<skill>`:

```python
import projects

# The only saved project; name one when there are several.
hcloud_client = projects.connect()
{
    "ready": True,
    "projects": projects.list_projects(),
    "locations": [location.name for location in hcloud_client.locations.get_all()],
    "servers": len(hcloud_client.servers.get_all()),
}
```

If it throws, its message names the one command that sets the skill up; run it, then the quickstart again. A call that changes something returns an action, or a response holding one: `action.wait_until_finished()` waits for Hetzner to finish it.
