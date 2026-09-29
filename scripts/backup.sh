#!/bin/sh
# Take one compressed dump and drop anything older than the retention window.
#
# A backup nobody has restored is a hope, not a backup. scripts/restore.sh is
# the other half, and docs/deploy.md records when it was last exercised.
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

mkdir -p "$BACKUP_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="$BACKUP_DIR/taskmanager-$STAMP.dump"

echo "Backing up to $TARGET"

# Custom format: compressed, and restorable table by table if it ever matters.
pg_dump --dbname="$DATABASE_URL" --format=custom --no-owner --no-privileges --file="$TARGET.partial"

# Only named once complete, so a half-written file is never mistaken for a backup.
mv "$TARGET.partial" "$TARGET"

SIZE="$(wc -c < "$TARGET")"
if [ "$SIZE" -lt 1024 ]; then
  echo "Refusing a suspiciously small backup ($SIZE bytes)" >&2
  exit 1
fi

echo "Wrote $TARGET ($SIZE bytes)"

# Off-site copy. A backup on the same disk as the database protects against
# very little.
if [ -n "${S3_BACKUP_BUCKET:-}" ]; then
  echo "Copying to s3://$S3_BACKUP_BUCKET/"
  aws s3 cp "$TARGET" "s3://$S3_BACKUP_BUCKET/" --only-show-errors
fi

find "$BACKUP_DIR" -name 'taskmanager-*.dump' -type f -mtime "+$RETENTION_DAYS" -print -delete
echo "Backup complete"
