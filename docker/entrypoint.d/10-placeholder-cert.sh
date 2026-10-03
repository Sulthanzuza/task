#!/bin/sh
# A certificate that exists, so nginx can start and certbot can reach it.
#
# The first deploy is a deadlock otherwise: nginx will not start without a
# certificate file, and Let's Encrypt cannot issue one without answering a
# challenge that nginx has to serve. A self-signed placeholder breaks it.
# Browsers will warn for the minute or two before certbot runs; nothing is
# published to real users in that window.
#
# Replaced on the first successful issuance and never written again, because
# it is only created when the path is empty.
set -eu

: "${SERVER_NAME:?SERVER_NAME is required}"
LIVE="/etc/letsencrypt/live/$SERVER_NAME"

if [ -s "$LIVE/fullchain.pem" ] && [ -s "$LIVE/privkey.pem" ]; then
  echo "TLS: using the certificate already in $LIVE"
  exit 0
fi

echo "TLS: no certificate yet, writing a self-signed placeholder for $SERVER_NAME"
mkdir -p "$LIVE"
openssl req -x509 -newkey rsa:2048 -nodes -days 3 \
  -keyout "$LIVE/privkey.pem" \
  -out "$LIVE/fullchain.pem" \
  -subj "/CN=$SERVER_NAME" >/dev/null 2>&1

# Three days, deliberately. If the real certificate never arrives, this
# expires loudly rather than sitting there looking like TLS for a year.
