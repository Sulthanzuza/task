#!/bin/sh
# Take one compressed dump, copy it and the uploaded files off this server,
# and drop anything older than the retention window at both ends.
#
# A backup on the same disk as the database protects against almost nothing:
# the disk, the server and the provider account are all single points of
# failure, and ransomware reaches a local folder first. So the copy that
# counts is the remote one, and scripts/restore.sh pulls from there.
#
# A backup nobody has restored is a hope, not a backup. docs/deploy.md
# records when the restore was last exercised.
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_S3_ENDPOINT:?BACKUP_S3_ENDPOINT is required (a provider that is not this server)}"
: "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET is required}"
: "${BACKUP_S3_ACCESS_KEY:?BACKUP_S3_ACCESS_KEY is required}"
: "${BACKUP_S3_SECRET_KEY:?BACKUP_S3_SECRET_KEY is required}"

BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

mkdir -p "$BACKUP_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="$BACKUP_DIR/taskmanager-$STAMP.dump"

# ---------------------------------------------------------------------------
# The database
# ---------------------------------------------------------------------------

echo "Backing up to $TARGET"

# Only these schemas, when set. On Supabase the database also holds Supabase's
# own (auth, storage, realtime, ...), which belong to roles and extensions
# that exist nowhere else, so a whole-database dump would not restore into a
# plain Postgres. The app's data is in public, pgboss and drizzle.
SCHEMA_ARGS=""
for schema in $(printf '%s' "${PG_DUMP_SCHEMAS:-}" | tr ',' ' '); do
  SCHEMA_ARGS="$SCHEMA_ARGS --schema=$schema"
done

# Custom format: compressed, and restorable table by table if it ever matters.
# SCHEMA_ARGS is a list of flags, split on purpose.
# shellcheck disable=SC2086
pg_dump --dbname="$DATABASE_URL" --format=custom --no-owner --no-privileges \
  $SCHEMA_ARGS --file="$TARGET.partial"

# Only named once complete, so a half-written file is never mistaken for a backup.
mv "$TARGET.partial" "$TARGET"

SIZE="$(wc -c < "$TARGET")"
if [ "$SIZE" -lt 1024 ]; then
  echo "Refusing a suspiciously small backup ($SIZE bytes)" >&2
  exit 1
fi

echo "Wrote $TARGET ($SIZE bytes)"

# ---------------------------------------------------------------------------
# Off this server
# ---------------------------------------------------------------------------

# Certificate checking stays on: an endpoint that cannot present a valid
# certificate is not somewhere to put the only copy of the data.
. "$(dirname "$0")/rclone-remotes.sh"

# The bucket is made by hand, once, at the provider: the key here is scoped to
# it and cannot create one. Fail loudly if it is not reachable rather than
# discovering it at restore time.
if ! rclone lsf --max-depth 1 "backup:$BACKUP_S3_BUCKET" >/dev/null; then
  echo "Cannot reach bucket $BACKUP_S3_BUCKET at $BACKUP_S3_ENDPOINT: check the endpoint, region and key" >&2
  exit 1
fi

echo "Uploading the dump to $BACKUP_S3_BUCKET/database/"
rclone copyto --quiet "$TARGET" "backup:$BACKUP_S3_BUCKET/database/$(basename "$TARGET")"

# The attachments. Without them a restore gives everybody their tasks back
# with every file on them broken, which is a restore that fails review.
if [ -n "${S3_BUCKET:-}" ] && [ -n "${S3_ENDPOINT:-}" ]; then
  echo "Copying $S3_BUCKET to $BACKUP_S3_BUCKET/files/"
  # copy, not sync: a file deleted here should not vanish from the backup on
  # the next run, or the backup follows the mistake within a day.
  rclone copy --quiet "files:$S3_BUCKET" "backup:$BACKUP_S3_BUCKET/files"
else
  echo "No S3_BUCKET configured; attachments were not backed up" >&2
fi

# ---------------------------------------------------------------------------
# Retention, at both ends
# ---------------------------------------------------------------------------

# On B2 a delete through the S3 API only hides the file; the bucket's
# lifecycle rule ("keep only the last version") is what removes it a day
# later. See docs/deploy.md.
echo "Removing remote dumps older than $RETENTION_DAYS days"
rclone delete --quiet --min-age "${RETENTION_DAYS}d" "backup:$BACKUP_S3_BUCKET/database" ||
  echo "Remote retention failed; old dumps were left in place" >&2

# Local copies are a convenience for a fast restore, not the backup, so they
# are kept for a shorter time than the remote ones.
find "$BACKUP_DIR" -name 'taskmanager-*.dump' -type f -mtime "+${BACKUP_LOCAL_RETENTION_DAYS:-3}" \
  -print -delete

echo "Backup complete"
