#!/bin/sh
# Pick up a new or renewed certificate without a restart.
#
# Certbot runs in its own container and writes into the shared volume. nginx
# reads its certificate once, at load, so without this it would keep serving
# the old one: the placeholder after the first issuance, or an expired
# certificate after a renewal. Both are silent.
#
# Six hours, against a certbot that renews twice a day. Re-pointing the
# symlink first is what turns the first issuance into a live certificate.
set -eu

(
  while true; do
    sleep 6h
    /usr/local/bin/use-real-cert >/dev/null 2>&1 || true
  done
) &
