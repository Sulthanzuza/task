# syntax=docker/dockerfile:1

# pg_dump and an S3 client in one image.
#
# The backup job needs both: the dump itself, and a way to put it somewhere
# that is not this server. rclone speaks plain S3, so the same image works
# against Backblaze B2, Cloudflare R2, Wasabi or anything else with an S3
# endpoint, and it comes from the Alpine archive for every architecture this
# runs on, arm64 included. (It replaced MinIO's mc, whose downloads were
# withdrawn in 2025: a build that fetches a binary from a vendor's URL breaks
# the day the vendor changes its mind.)
FROM postgres:16-alpine

RUN apk add --no-cache ca-certificates rclone \
 && rclone version

ENTRYPOINT ["/bin/sh", "/scripts/backup-loop.sh"]
