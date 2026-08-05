FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    procps \
    git \
    curl \
    ca-certificates \
    build-essential \
    python3 \
    python3-pip \
    python3-venv \
    tmux \
    ripgrep \
    && rm -rf /var/lib/apt/lists/*

RUN curl -sLO https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 \
    && chmod +x ttyd.x86_64 \
    && mv ttyd.x86_64 /usr/local/bin/ttyd
RUN npm install -g opencode-ai

COPY inject.py /app/inject.py
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh && chown -R node:node /app

RUN mkdir -p /home/node/.config /home/node/.local/state /home/node/.local/share \
    && chown -R node:node /home/node

WORKDIR /workspace
USER node
ENTRYPOINT ["opencode"]
