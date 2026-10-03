#!/bin/sh
# Restore a dump into a database, and prove it worked.
#
# Intended for a scratch database. It refuses to touch anything whose name does
# not say it is a restore target, because the whole point of practising a
# restore is to not destroy the thing you are protecting.
#
# With `remote` as the dump argument it fetches the newest dump from the
# off-site bucket instead of reading a local file. That is the copy the
# drill has to exercise: restoring the file still sitting on the server
# proves the dump is readable, and nothing about whether the backup that
# matters actually arrived anywhere.
set -eu

DUMP="${1:-}"
TARGET_URL="${2:-${RESTORE_DATABASE_URL:-}}"

if [ -z "$DUMP" ] || [ -z "$TARGET_URL" ]; then
  echo "Usage: restore.sh <dump-file|remote|remote:NAME> <target-database-url>" >&2
  exit 2
fi

case "$DUMP" in
  remote|remote:*)
    : "${BACKUP_S3_ENDPOINT:?BACKUP_S3_ENDPOINT is required to restore from the remote copy}"
    : "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET is required}"
    : "${BACKUP_S3_ACCESS_KEY:?BACKUP_S3_ACCESS_KEY is required}"
    : "${BACKUP_S3_SECRET_KEY:?BACKUP_S3_SECRET_KEY is required}"

    mc alias set backup "$BACKUP_S3_ENDPOINT" "$BACKUP_S3_ACCESS_KEY" "$BACKUP_S3_SECRET_KEY" >/dev/null

    WANTED="${DUMP#remote}"
    WANTED="${WANTED#:}"
    if [ -z "$WANTED" ]; then
      # Newest by name, which sorts correctly because the stamp is ISO-8601.
      WANTED="$(mc ls "backup/$BACKUP_S3_BUCKET/database/" | awk '{print $NF}' | sort | tail -1)"
      if [ -z "$WANTED" ]; then
        echo "No dumps found in $BACKUP_S3_BUCKET/database/" >&2
        exit 1
      fi
    fi

    LOCAL="/tmp/$WANTED"
    echo "Fetching $WANTED from the off-site bucket"
    mc cp --quiet "backup/$BACKUP_S3_BUCKET/database/$WANTED" "$LOCAL"
    DUMP="$LOCAL"
    ;;
esac

if [ ! -s "$DUMP" ]; then
  echo "No such dump, or it is empty: $DUMP" >&2
  exit 1
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

# Left behind, a fetched dump is an unencrypted copy of the whole database
# sitting in /tmp on a running server.
case "${LOCAL:-}" in
  /tmp/*) rm -f "$LOCAL" ;;
esac
