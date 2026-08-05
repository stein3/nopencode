#!/bin/sh
INDEX=/app/index.html
if [ ! -f "$INDEX" ]; then
  ttyd -W -p 7699 sh >/dev/null 2>&1 &
  TTYD_PID=$!
  sleep 1
  curl -sf http://127.0.0.1:7699/ -o /tmp/index-raw.html && python3 /app/inject.py /tmp/index-raw.html "$INDEX"
  kill "$TTYD_PID" 2>/dev/null || true
fi
if [ -f "$INDEX" ]; then
  exec ttyd -I "$INDEX" "$@"
fi
exec ttyd "$@"
