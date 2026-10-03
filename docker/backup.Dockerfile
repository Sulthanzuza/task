# syntax=docker/dockerfile:1

# pg_dump and an S3 client in one image.
#
# The backup job needs both: the dump itself, and a way to put it somewhere
# that is not this server. mc is a single static binary and speaks plain S3,
# so the same image works against Backblaze B2, Cloudflare R2, Wasabi or
# anything else with an S3 endpoint.
FROM postgres:16-alpine

RUN apk add --no-cache ca-certificates curl \
 && ARCH="$(uname -m)" \
 && case "$ARCH" in \
      x86_64)  MC_ARCH=amd64 ;; \
      aarch64) MC_ARCH=arm64 ;; \
      *) echo "unsupported architecture $ARCH" >&2; exit 1 ;; \
    esac \
 && curl -fsSL "https://dl.min.io/client/mc/release/linux-${MC_ARCH}/mc" -o /usr/local/bin/mc \
 && chmod +x /usr/local/bin/mc \
 && mc --version

ENTRYPOINT ["/bin/sh", "/scripts/backup-loop.sh"]
