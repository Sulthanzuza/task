#!/bin/sh
# The two S3 remotes the backup scripts use, defined from the environment.
#
# rclone reads a remote called NAME from RCLONE_CONFIG_NAME_<OPTION>, so no
# config file holding the keys is written anywhere and nothing secret goes on
# a command line, where `ps` would show it. Sourced, not run.
#
#   backup:  the off-site bucket (BACKUP_S3_*), at a different provider
#   files:   the attachments bucket the API writes to (S3_*)

# No config file at all; without this rclone looks for one and logs that it
# found none on every run.
export RCLONE_CONFIG=""

export RCLONE_CONFIG_BACKUP_TYPE=s3
export RCLONE_CONFIG_BACKUP_PROVIDER=Other
export RCLONE_CONFIG_BACKUP_ENDPOINT="${BACKUP_S3_ENDPOINT:-}"
export RCLONE_CONFIG_BACKUP_REGION="${BACKUP_S3_REGION:-}"
export RCLONE_CONFIG_BACKUP_ACCESS_KEY_ID="${BACKUP_S3_ACCESS_KEY:-}"
export RCLONE_CONFIG_BACKUP_SECRET_ACCESS_KEY="${BACKUP_S3_SECRET_KEY:-}"
# The key is scoped to one bucket and cannot create or list others, so rclone
# must not try to check for, or make, the bucket before writing to it.
export RCLONE_CONFIG_BACKUP_NO_CHECK_BUCKET=true

export RCLONE_CONFIG_FILES_TYPE=s3
export RCLONE_CONFIG_FILES_PROVIDER=Other
export RCLONE_CONFIG_FILES_ENDPOINT="${S3_ENDPOINT:-}"
export RCLONE_CONFIG_FILES_REGION="${S3_REGION:-}"
export RCLONE_CONFIG_FILES_ACCESS_KEY_ID="${S3_ACCESS_KEY_ID:-}"
export RCLONE_CONFIG_FILES_SECRET_ACCESS_KEY="${S3_SECRET_ACCESS_KEY:-}"
export RCLONE_CONFIG_FILES_FORCE_PATH_STYLE=true
export RCLONE_CONFIG_FILES_NO_CHECK_BUCKET=true
