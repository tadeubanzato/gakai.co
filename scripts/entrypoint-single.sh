#!/bin/sh
set -eu

# The WhatsApp runtime remains an internal process. Gakai listens separately
# on 3001 and is the only port exposed from the combined image.
/entrypoint.sh &
provider_pid=$!
node /gakai/server.mjs &
gakai_pid=$!

stop() {
  kill -TERM "$gakai_pid" "$provider_pid" 2>/dev/null || true
  wait "$gakai_pid" 2>/dev/null || true
  wait "$provider_pid" 2>/dev/null || true
  exit 0
}
trap stop INT TERM

# Exit the container when either essential process has stopped. Docker restart
# policy then restores a known-good combined runtime instead of leaving a
# dashboard connected to a dead provider process.
while kill -0 "$gakai_pid" 2>/dev/null && kill -0 "$provider_pid" 2>/dev/null; do
  sleep 2
done

stop
