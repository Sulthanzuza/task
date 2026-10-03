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

# Custom format: compressed, and restorable table by table if it ever matters.
pg_dump --dbname="$DATABASE_URL" --format=custom --no-owner --no-privileges \
  --file="$TARGET.partial"

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

# --insecure is deliberately not set: an endpoint that cannot present a valid
# certificate is not somewhere to put the only copy of the data.
mc alias set backup "$BACKUP_S3_ENDPOINT" "$BACKUP_S3_ACCESS_KEY" "$BACKUP_S3_SECRET_KEY" \
  ${BACKUP_S3_REGION:+--api S3v4} >/dev/null

if ! mc ls "backup/$BACKUP_S3_BUCKET" >/dev/null 2>&1; then
  echo "Creating bucket $BACKUP_S3_BUCKET"
  mc mb --ignore-existing "backup/$BACKUP_S3_BUCKET" >/dev/null
fi

echo "Uploading the dump to $BACKUP_S3_BUCKET/database/"
mc cp --quiet "$TARGET" "backup/$BACKUP_S3_BUCKET/database/"

# The attachments. Without them a restore gives everybody their tasks back
# with every file on them broken, which is a restore that fails review.
if [ -n "${S3_BUCKET:-}" ] && [ -n "${S3_ENDPOINT:-}" ]; then
  mc alias set files "$S3_ENDPOINT" "${S3_ACCESS_KEY_ID:-}" "${S3_SECRET_ACCESS_KEY:-}" >/dev/null
  echo "Mirroring $S3_BUCKET to $BACKUP_S3_BUCKET/files/"
  # --overwrite, not --remove: a file deleted here should not vanish from the
  # backup on the next run, or the backup follows the mistake within a day.
  mc mirror --quiet --overwrite "files/$S3_BUCKET" "backup/$BACKUP_S3_BUCKET/files/"
else
  echo "No S3_BUCKET configured; attachments were not backed up" >&2
fi

# ---------------------------------------------------------------------------
# Retention, at both ends
# ---------------------------------------------------------------------------

echo "Removing remote dumps older than $RETENTION_DAYS days"
mc rm --quiet --recursive --force --older-than "${RETENTION_DAYS}d" \
  "backup/$BACKUP_S3_BUCKET/database/" || true

# Local copies are a convenience for a fast restore, not the backup, so they
# are kept for a shorter time than the remote ones.
find "$BACKUP_DIR" -name 'taskmanager-*.dump' -type f -mtime "+${BACKUP_LOCAL_RETENTION_DAYS:-3}" \
  -print -delete

echo "Backup complete"
