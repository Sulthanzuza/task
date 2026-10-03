#!/bin/sh
# Pick up a renewed certificate without a restart.
#
# Certbot renews in its own container and writes into the shared volume.
# nginx reads the certificate once at startup, so without this it would keep
# serving the expired one until somebody noticed. Reloading every twelve
# hours is cheap and needs no access to the Docker socket, which the
# alternative (a deploy hook running `docker exec`) would.
set -eu

(
  while true; do
    sleep 12h
    nginx -s reload 2>/dev/null || true
  done
) &
