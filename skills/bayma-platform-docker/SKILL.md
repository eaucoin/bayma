---
name: bayma-platform-docker
description: Inspect the source code of and execute code from the installed `docker` Python package, the Docker Engine SDK; drive the Docker Engine this skill is connected to, on this machine or another.
---

# Docker Platform

This skill shows you where to find the relevant packages to reference when writing correct source code or interactively executing code that interacts with the platform appropriately. The skill owns its packages and its connection to a Docker Engine; both live in its own folder, `<skill>` below. The Engine itself is a daemon of the machine it runs on.

## Reference Materials

The reference materials for this skill are the installed package source and documentation under:

- `<skill>/site-packages/docker/**`: `docker.DockerClient`, for containers, images, networks, and volumes, and Swarm's services, nodes, secrets, and configs
- `<skill>/site-packages/docker/api/**`: `docker.APIClient`, one method per Engine API endpoint
- https://docs.docker.com/reference/api/engine/: the Engine API both speak

If these materials are missing, set the skill up, in a bayma Python session whose `cwd` is `<skill>`:

```python
import subprocess, sys

ran = subprocess.run([sys.executable, "-I", "engine.py"], capture_output=True, text=True)
ran.stdout + ran.stderr
```

## Interactive Quickstart

In a bayma Python session whose `cwd` is `<skill>`:

```python
import engine

docker_client = engine.connect()
docker_version = docker_client.version()
{
    "ready": docker_client.ping(),
    "engine": docker_version["Version"],
    "api": docker_version["ApiVersion"],
    "platform": f"{docker_version['Os']}/{docker_version['Arch']}",
}
```

If it throws, its message names the one command that sets the skill up; run it, then the quickstart again. To drive an Engine on another machine, name it to that command: `ssh://user@host`, through this machine's `ssh`, or `tcp://host:2376 --tls <directory of ca.pem, cert.pem, and key.pem>`.
