#!/bin/sh
# Point /etc/nginx/tls at the real certificate, if there is one, and reload.
#
# Run by the renewal watcher every six hours, and by hand straight after the
# first issuance so nobody waits six hours for HTTPS to start working.
set -eu

: "${SERVER_NAME:?SERVER_NAME is required}"
REAL="/etc/letsencrypt/live/$SERVER_NAME"

if [ ! -s "$REAL/fullchain.pem" ]; then
  echo "No certificate in $REAL yet; still on the placeholder." >&2
  exit 1
fi

ln -sfn "$REAL" /etc/nginx/tls
nginx -s reload
echo "nginx is serving the certificate in $REAL"
