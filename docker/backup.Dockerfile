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
# pg_dump must be at least as new as the server it dumps: 16 for the Docker
# deployment's Postgres, 17 for Supabase (the GitHub Actions backup builds
# with --build-arg PG_MAJOR=17). A newer pg_dump reads an older server fine.
ARG PG_MAJOR=16
FROM postgres:${PG_MAJOR}-alpine

RUN apk add --no-cache ca-certificates rclone \
 && rclone version

ENTRYPOINT ["/bin/sh", "/scripts/backup-loop.sh"]
