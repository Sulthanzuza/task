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

    . "$(dirname "$0")/rclone-remotes.sh"

    WANTED="${DUMP#remote}"
    WANTED="${WANTED#:}"
    if [ -z "$WANTED" ]; then
      # Newest by name, which sorts correctly because the stamp is ISO-8601.
      WANTED="$(rclone lsf --files-only "backup:$BACKUP_S3_BUCKET/database" | grep '\.dump$' | sort | tail -1)"
      if [ -z "$WANTED" ]; then
        echo "No dumps found in $BACKUP_S3_BUCKET/database/" >&2
        exit 1
      fi
    fi

    LOCAL="/tmp/$WANTED"
    echo "Fetching $WANTED from the off-site bucket"
    rclone copyto --quiet "backup:$BACKUP_S3_BUCKET/database/$WANTED" "$LOCAL"
    DUMP="$LOCAL"
    ;;
esac

if [ ! -s "$DUMP" ]; then
  echo "No such dump, or it is empty: $DUMP" >&2
  exit 1
fi

DB_NAME="$(basename "$TARGET_URL" | sed 's/?.*//')"

# user@host:port/database, without the password: what makes two URLs the same
# database. On Supabase two projects share the pooler's host name, and only
# the user (postgres.<project-ref>) tells them apart.
identity() {
  printf '%s' "$1" | sed -E 's#^[a-z]+://([^:@/]+)(:[^@]*)?@([^/?]+)/([^?]*).*#\1@\3/\4#'
}

# Never the live database, however the target is named.
if [ -n "${RESTORE_FORBIDDEN_URL:-}" ] && [ "$(identity "$TARGET_URL")" = "$(identity "$RESTORE_FORBIDDEN_URL")" ]; then
  echo "Refusing to restore into the production database ($(identity "$TARGET_URL"))" >&2
  exit 1
fi

case "$DB_NAME" in
  *_restore|*_scratch|*_verify) ;;
  *)
    # A scratch Supabase project's database is always called postgres, so it
    # cannot carry the suffix; naming it here is the explicit opt-in, and is
    # only accepted together with RESTORE_FORBIDDEN_URL.
    if [ -n "${RESTORE_ALLOW_DATABASE:-}" ] && [ "$DB_NAME" = "$RESTORE_ALLOW_DATABASE" ] &&
      [ -n "${RESTORE_FORBIDDEN_URL:-}" ]; then
      :
    else
      echo "Refusing to restore into '$DB_NAME': name it *_restore, *_scratch or *_verify" >&2
      exit 1
    fi
    ;;
esac

echo "Restoring $DUMP into $DB_NAME"

# Start from empty schemas rather than pg_restore --clean. --clean cannot
# take pg-boss's partitioned job tables apart in the right order, so a second
# drill into the same scratch database would fail. The target has already
# been checked: it is a *_restore database or an opted-in scratch project,
# never the live one, so wiping the app's three schemas is the point.
#
# A dump of selected schemas also carries no CREATE EXTENSION, and the tables
# need these two: citext for email addresses, pg_trgm for search.
psql "$TARGET_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
DROP SCHEMA IF EXISTS pgboss CASCADE;
DROP SCHEMA IF EXISTS drizzle CASCADE;
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
SQL

# Everything in the dump except the public schema itself, which now exists.
LIST="$(mktemp)"
pg_restore --list "$DUMP" | grep -v ' SCHEMA - public ' > "$LIST"

pg_restore --dbname="$TARGET_URL" --no-owner --no-privileges --exit-on-error   --use-list="$LIST" "$DUMP"
rm -f "$LIST"

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
