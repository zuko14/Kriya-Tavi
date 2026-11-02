# syntax=docker/dockerfile:1

# kriya-runner (track C, CD-21): the service inside every cloud workspace
# sandbox. Node 24, git, ripgrep, Python and build tools; a `kriya` user
# (uid 1000, no sudo) owns /workspace and runs every command. The runner
# itself runs as root inside the VM so it can start commands as `kriya` and
# keep its token out of their reach; the VM is the isolation boundary
# (CD-06). Only runner/ and browser/egress.ts (the egress predicates, CD-12)
# are copied in: no lib/, no database code, no secret.
# CD-12 in the image: at start the root runner installs an iptables chain
# that lets `kriya` reach loopback only, and serves an allow-listed registry
# proxy on 127.0.0.1:10001 (runner/egress.ts). It needs CAP_NET_ADMIN in the
# sandbox (Docker: --cap-add NET_ADMIN) and refuses to start without it.
# Build from the repository root (an owner-run step, then registered as the
# provider template named by the cloud.image setting):
#   docker build -f runner/Dockerfile -t kriya-runner:<version> .
# SBOM, kept with the version:
#   syft kriya-runner:<version> -o spdx-json > kriya-runner-<version>.spdx.json

FROM debian:trixie-slim

ARG NODE_VERSION=24.20.0
# Keep both equal to package-lock.json
ARG ZOD_VERSION=4.6.7
ARG TSX_VERSION=4.23.15

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    NODE_ENV=production

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils tini \
      git ripgrep python3 python3-venv zstd build-essential \
      iptables procps util-linux \
 && rm -rf /var/lib/apt/lists/*

RUN arch="$(dpkg --print-architecture)" \
 && case "$arch" in amd64) node_arch=x64 ;; arm64) node_arch=arm64 ;; *) echo "unsupported: $arch" >&2; exit 1 ;; esac \
 && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
    | tar -xJ -C /usr/local --strip-components=1 --no-same-owner \
 && node --version

WORKDIR /app
RUN echo '{"type":"module","private":true}' > package.json \
 && npm install --no-save --no-package-lock "zod@${ZOD_VERSION}" "tsx@${TSX_VERSION}" \
 && rm -rf /root/.npm

COPY runner/ ./runner/
COPY browser/egress.ts ./browser/egress.ts

# CS-9: the runner sets these on every command with prlimit (runner/exec.ts
# NPROC); this file holds the same numbers for PAM logins, which commands
# don't use. The sandbox's pids limit (provider, or Docker --pids-limit) is
# the outer bound
RUN useradd --create-home --uid 1000 --shell /bin/bash kriya \
 && mkdir /workspace \
 && chown kriya:kriya /workspace \
 && mkdir -p /etc/security/limits.d \
 && printf 'kriya hard nproc 512\nkriya soft nproc 256\n' > /etc/security/limits.d/kriya.conf

EXPOSE 10000
ENTRYPOINT ["tini", "--"]
CMD ["npx", "tsx", "runner/index.ts"]
