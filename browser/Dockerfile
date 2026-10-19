# syntax=docker/dockerfile:1

# kriya-browser (AD-08): Node + playwright-core + the Chromium build pinned to
# that playwright-core version, installed at image build. No desktop, no
# sudo, a non-root user, and the Chromium sandbox on (never --no-sandbox).
# Build from the repository root:
#   docker build -f browser/Dockerfile .

FROM debian:trixie-slim

ARG NODE_VERSION=24.20.0
# Keep both equal to package-lock.json
ARG PLAYWRIGHT_CORE_VERSION=1.64.1
ARG TSX_VERSION=4.23.15
ARG WS_VERSION=8.22.0

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils tini \
      fonts-noto-core fonts-noto-color-emoji fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

RUN arch="$(dpkg --print-architecture)" \
 && case "$arch" in amd64) node_arch=x64 ;; arm64) node_arch=arm64 ;; *) echo "unsupported: $arch" >&2; exit 1 ;; esac \
 && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
    | tar -xJ -C /usr/local --strip-components=1 --no-same-owner \
 && node --version

WORKDIR /app
RUN echo '{"type":"module","private":true}' > package.json \
 && npm install --no-save --no-package-lock "playwright-core@${PLAYWRIGHT_CORE_VERSION}" "tsx@${TSX_VERSION}" "ws@${WS_VERSION}" \
 && npx playwright-core install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm

# Only the service's own files: no lib/, no database code, no other secrets
COPY browser/ ./browser/

RUN useradd --create-home --uid 1000 --shell /usr/sbin/nologin kriya
USER kriya
EXPOSE 10000
ENTRYPOINT ["tini", "--"]
CMD ["npx", "tsx", "browser/index.ts"]
