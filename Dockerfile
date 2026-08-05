# 1. Use an official lightweight Node.js runtime as the base
FROM node:20-slim

# 2. Install essential system dependencies (git, curl, SSH, build tools),
#    and the Python 3 toolchain
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    build-essential \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# 3. Install OpenCode globally via npm (or curl script)
RUN npm install -g opencode-ai

# 4. Create and set a non-root working directory
WORKDIR /workspace

# 5. Switch to a non-root user for security when mounting local host files
USER node

# 6. Launch the OpenCode web interface, bound to all interfaces so it's
#    reachable from other machines on the network
ENTRYPOINT ["opencode"]