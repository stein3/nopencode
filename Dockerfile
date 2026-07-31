# 1. Use an official lightweight Node.js runtime as the base
FROM node:20-slim

# 2. Install essential system dependencies (git, curl, SSH, build tools)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 3. Install OpenCode globally via npm (or curl script)
RUN npm install -g opencode-ai

# 4. Create and set a non-root working directory
WORKDIR /workspace

# 5. Switch to a non-root user for security when mounting local host files
USER node

# 6. Set the entrypoint to launch OpenCode directly when the container runs
ENTRYPOINT ["opencode"]