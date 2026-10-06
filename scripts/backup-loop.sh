#!/bin/sh
# The backup container: run once at start, then once a day.
#
# A cron daemon in a container is another thing to get wrong; a loop that logs
# to stdout is visible in `docker compose logs` like everything else.
set -eu

INTERVAL="${BACKUP_INTERVAL_SECONDS:-86400}"

while true; do
  if /bin/sh /scripts/backup.sh; then
    echo "$(date -u +%FT%TZ) backup ok"
  else
    echo "$(date -u +%FT%TZ) backup FAILED" >&2
  fi
  sleep "$INTERVAL"
done
