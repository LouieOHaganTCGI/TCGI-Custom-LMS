#!/usr/bin/env bash
# Restart the local dev stack (dev/dev-stack.ts) in the background, logging to var/dev.log.
set -euo pipefail
PID_FILE=var/dev-stack.pid
mkdir -p var
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then kill "$(cat "$PID_FILE")"; sleep 1; fi
for port in 3000 3001 4400 4500; do fuser -k -TERM "$port/tcp" >/dev/null 2>&1 || true; done
nohup npx tsx dev/dev-stack.ts > var/dev.log 2>&1 &
echo $! > "$PID_FILE"
for _ in $(seq 1 40); do sleep 0.5; curl -sf http://localhost:3000/health >/dev/null && { tail -5 var/dev.log; exit 0; }; done
echo "dev stack failed to start:"; cat var/dev.log; exit 1
