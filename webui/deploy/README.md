# Merge guide (Phase 2) — do NOT apply blindly; coordinate with parallel work.
#
# 1) compose.yaml — append inside `services:` :
#
#   webchat:
#     image: nopencode:latest
#     container_name: opencode-webchat
#     restart: unless-stopped
#     entrypoint: ["python3", "/app/chatserver.py"]
#     ports:
#       - "7683:8080"
#     volumes:
#       - opencode-share:/home/node/.local/share/opencode:ro
#     environment:
#       - OC_ENGINE=http://opencode-engine:4096
#     depends_on:
#       - opencode-engine
#
# 2) Dockerfile — add a build stage BEFORE the final FROM, and two COPY lines in
#    the final stage:
#
#   FROM node:23-slim AS webui-build
#   WORKDIR /src
#   COPY webui/package*.json ./
#   RUN npm ci --no-fund --no-audit || npm install --no-fund --no-audit
#   COPY webui/ ./
#   RUN npm run build
#
#   # ... existing final stage additions:
#   COPY chatserver.py /app/chatserver.py
#   COPY --from=webui-build /src/dist /app/webui/dist
#
# Notes:
#  - chatserver.py reads OC_DB from the default path (/home/node/.local/share/opencode)
#    so only the share volume is needed, mounted READ-ONLY on purpose.
#  - Phase 3 will flip host port 7681 to this service; until then ttyd keeps 7681.
#  - No auth by design (trusted LAN). Do not port-forward 7683 raw.
