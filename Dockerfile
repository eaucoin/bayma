# bayma's image: the server bundle, the payload of runtimes it hosts, and what
# process snapshots take, on Ubuntu 24.04. Built by `bun run image` from what
# `bun run build` and `bun run payload` leave in dist/.
#
# Run it as the bayma command does (packages/cli/src/launcher.ts): as the
# invoking user, with their home mounted at the same path, and with the
# capabilities and seccomp profile CRIU needs.

FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS node

# CRIU, built from its source at its v4.2.1 tag's commit, since Ubuntu's
# archive no longer ships it, and the CRIU project's PPA keeps only its latest
# build (Launchpad deletes a PPA's superseded files soon after). The source is
# the PPA's, which patches none of it, built with the libraries the PPA's build
# linked; only the binary goes into the image.
FROM ubuntu:24.04@sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3 AS criu
ARG CRIU_COMMIT=9539417f3e3cfa4eb84c319cd71f4d52f1f08645
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates gcc git libbsd-dev libc6-dev libcap-dev libgnutls28-dev \
      libnet1-dev libnftables-dev libnl-3-dev libprotobuf-c-dev libprotobuf-dev \
      make pkg-config protobuf-c-compiler protobuf-compiler python3 uuid-dev \
 && git init -q /criu \
 && git -C /criu fetch -q --depth 1 https://github.com/checkpoint-restore/criu.git "${CRIU_COMMIT}" \
 && git -C /criu checkout -q FETCH_HEAD \
 && make -C /criu -j"$(nproc)" criu

FROM ubuntu:24.04@sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3

LABEL org.opencontainers.image.title="bayma" \
      org.opencontainers.image.description="Long-lived REPL sessions in eight language runtimes, over MCP" \
      org.opencontainers.image.source="https://github.com/eaucoin/bayma" \
      org.opencontainers.image.licenses="MIT"

# CRIU, beside the libraries it links. It runs unprivileged, with only the
# capabilities its binary holds: a user in a container gets them when the
# container's bounding set has them (docker run --cap-add CHECKPOINT_RESTORE
# --cap-add SYS_PTRACE; SETPCAP is in Docker's default set, and a restore needs
# it to drop what a task lacked). gcc and libc6-dev are the `cc` the Rust
# runtime links cells with; ICU, the globalization the .NET runtime expects.
COPY --from=criu /criu/criu/criu /usr/local/bin/criu
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates gcc git libbsd0 libc6-dev libcap2-bin libgnutls30t64 libicu74 \
      libnet1 libnftables1 libnl-3-200 libprotobuf-c1 procps tini tzdata \
 && criu --version \
 && setcap cap_checkpoint_restore,cap_sys_ptrace,cap_setpcap+eip /usr/local/bin/criu \
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
COPY dist/bayma /opt/bayma
ENV BAYMA_PAYLOAD_DIR=/opt/bayma/payload

# The server, and every runtime and program its REPL sessions start, write no
# core file as they crash, as on an Ubuntu host (a soft limit of 0, which code
# a session runs may raise): the container runtime leaves the limit unlimited,
# and the kernel's default core_pattern writes a core into the crashing
# process's directory, one of the user's own mounted from their machine: a
# runtime's whole memory, of GBs, at each crash. prlimit execs tini, which
# stays the container's first process.
ENTRYPOINT ["prlimit", "--core=0:", "--", "tini", "--", "node", "--disable-warning=ExperimentalWarning", "/opt/bayma/bayma.js"]
CMD ["mcp-stdio"]
