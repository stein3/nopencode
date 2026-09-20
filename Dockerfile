FROM node:23-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    procps \
    git \
    curl \
    ca-certificates \
    python3 \
    tmux \
    ripgrep \
    imagemagick \
    && rm -rf /var/lib/apt/lists/*

RUN curl -sLO https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 \
    && chmod +x ttyd.x86_64 \
    && mv ttyd.x86_64 /usr/local/bin/ttyd
# Pinned: the serve API + bundled web UI surface is version-coupled; bump deliberately.
RUN npm install -g opencode-ai@1.18.18

COPY inject.py /app/inject.py
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh && chown -R node:node /app

# The opencode subdirs are the compose named-volume mount points; they must exist
# here so a fresh volume inherits node ownership instead of a root-owned mount point.
RUN mkdir -p /home/node/.config/opencode /home/node/.local/state /home/node/.local/share/opencode \
    && chown -R node:node /home/node/.config /home/node/.local/state /home/node/.local/share

# Make opencode's built-in bash-tool claim ("/tmp/opencode exists and is
# pre-approved") actually true: create it node-writable before dropping privs.
RUN mkdir -p /tmp/opencode && chown node:node /tmp/opencode

WORKDIR /workspace
USER node
ENTRYPOINT ["opencode"]
