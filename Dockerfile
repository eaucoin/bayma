# bayma's image: the server bundle, the payload of runtimes it hosts, and what
# process snapshots take, on Ubuntu 24.04. Built by `bun run image` from what
# `bun run build` and `bun run payload` leave in dist/.
#
# Run it as the bayma command does (packages/cli/src/launcher.ts): as the
# invoking user, with their home mounted at the same path, and with the
# capabilities and seccomp profile CRIU needs.

FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS node

FROM ubuntu:24.04@sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3

LABEL org.opencontainers.image.title="bayma" \
      org.opencontainers.image.description="Long-lived REPL sessions in eight language runtimes, over MCP" \
      org.opencontainers.image.source="https://github.com/eaucoin/bayma" \
      org.opencontainers.image.licenses="MIT"

# CRIU comes from the CRIU project's PPA, since Ubuntu's archive no longer
# ships it. It runs unprivileged, with only the capabilities its binary holds:
# a user in a container gets them when the container's bounding set has them
# (docker run --cap-add CHECKPOINT_RESTORE --cap-add SYS_PTRACE; SETPCAP is in
# Docker's default set, and a restore needs it to drop what a task lacked).
# gcc and libc6-dev are the `cc` the Rust runtime links cells with; ICU, the
# globalization the .NET runtime expects.
ARG CRIU_VERSION=4.2.1-1ppa1.24.04
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates gpg-agent software-properties-common \
 && add-apt-repository -y ppa:criu/ppa \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      "criu=${CRIU_VERSION}" gcc git libc6-dev libcap2-bin libicu74 procps tini tzdata \
 && setcap cap_checkpoint_restore,cap_sys_ptrace,cap_setpcap+eip "$(command -v criu)" \
 && apt-get purge -y --auto-remove gpg-agent software-properties-common \
 && rm -rf /var/lib/apt/lists/*

COPY --from=node /usr/local/bin/node /usr/local/bin/node

COPY packages/core/native/advance-pids.c /tmp/advance-pids.c
RUN gcc -O2 -Wall -Wextra -Werror -o /usr/local/bin/bayma-advance-pids /tmp/advance-pids.c \
 && rm /tmp/advance-pids.c

# The payload, a layer to each of its directories, so that they are pushed
# and pulled side by side. `bun run image` refuses a payload with more or
# fewer than these.
COPY dist/payload/bun /opt/bayma/payload/bun
COPY dist/payload/python /opt/bayma/payload/python
COPY dist/payload/dotnet-script /opt/bayma/payload/dotnet-script
COPY dist/payload/rust /opt/bayma/payload/rust
COPY dist/payload/clang /opt/bayma/payload/clang
COPY dist/payload/lean /opt/bayma/payload/lean
COPY dist/payload/go /opt/bayma/payload/go
COPY dist/payload/toolbelt /opt/bayma/payload/toolbelt
COPY dist/payload/payload.json /opt/bayma/payload/payload.json
COPY dist/bayma.js /opt/bayma/bayma.js
ENV BAYMA_PAYLOAD_DIR=/opt/bayma/payload

ENTRYPOINT ["tini", "--", "node", "--disable-warning=ExperimentalWarning", "/opt/bayma/bayma.js"]
CMD ["mcp-stdio"]
