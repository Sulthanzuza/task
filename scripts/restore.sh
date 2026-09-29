#!/bin/sh
# Restore a dump into a database, and prove it worked.
#
# Intended for a scratch database. It refuses to touch anything whose name does
# not say it is a restore target, because the whole point of practising a
# restore is to not destroy the thing you are protecting.
set -eu

DUMP="${1:-}"
TARGET_URL="${2:-${RESTORE_DATABASE_URL:-}}"

if [ -z "$DUMP" ] || [ -z "$TARGET_URL" ]; then
  echo "Usage: restore.sh <dump-file> <target-database-url>" >&2
  exit 2
fi

DB_NAME="$(basename "$TARGET_URL" | sed 's/?.*//')"
case "$DB_NAME" in
  *_restore|*_scratch|*_verify) ;;
  *)
    echo "Refusing to restore into '$DB_NAME': name it *_restore, *_scratch or *_verify" >&2
    exit 1
    ;;
esac

echo "Restoring $DUMP into $DB_NAME"

pg_restore --dbname="$TARGET_URL" --clean --if-exists --no-owner --no-privileges "$DUMP"

# A restore that finishes without error can still have restored nothing.
COUNT="$(psql "$TARGET_URL" -tAc "SELECT count(*) FROM tasks")"
USERS="$(psql "$TARGET_URL" -tAc "SELECT count(*) FROM users")"

echo "Restored $USERS users and $COUNT tasks"

if [ "$USERS" -lt 1 ]; then
  echo "Restore verification failed: no users in the restored database" >&2
  exit 1
fi

echo "Restore verified"
