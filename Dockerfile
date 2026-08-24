# Stage 1: build the webui (dist is not committed to the repo)
FROM node:23-slim AS webui-build
WORKDIR /build/webui
COPY webui/package.json webui/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY webui/ .
RUN npm run build

FROM node:23-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    procps \
    git \
    curl \
    ca-certificates \
    python3 \
    tmux \
    ripgrep \
    && rm -rf /var/lib/apt/lists/*

RUN curl -sLO https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 \
    && chmod +x ttyd.x86_64 \
    && mv ttyd.x86_64 /usr/local/bin/ttyd
# Pinned: the serve API + bundled web UI surface is version-coupled; bump deliberately.
RUN npm install -g opencode-ai@1.18.18

COPY inject.py /app/inject.py
COPY start.sh /app/start.sh
COPY chatserver.py /app/chatserver.py
COPY --from=webui-build /build/webui/dist /app/webui/dist
RUN chmod +x /app/start.sh && chown -R node:node /app

RUN mkdir -p /home/node/.config /home/node/.local/state /home/node/.local/share \
    && chown -R node:node /home/node/.config /home/node/.local/state /home/node/.local/share

WORKDIR /workspace
USER node
ENTRYPOINT ["opencode"]
