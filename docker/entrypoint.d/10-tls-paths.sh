#!/bin/sh
# Point nginx at whichever certificate exists, through a stable path.
#
# Two problems to solve at once.
#
# nginx will not start without a certificate file, and Let's Encrypt cannot
# issue one without answering a challenge that nginx has to serve. So there
# has to be something there on the very first boot.
#
# But that something must not live in /etc/letsencrypt/live/<domain>/.
# Certbot owns that directory. Finding it already populated by someone else,
# certbot writes to <domain>-0001 instead and leaves the original alone, so
# nginx would go on serving a self-signed certificate forever while the real
# one sat unused next to it. That failure is quiet: the site is up, it is
# just untrusted.
#
# So the placeholder lives somewhere certbot has no opinion about, and nginx
# reads /etc/nginx/tls, a symlink this script points at the real certificate
# as soon as there is one.
set -eu

: "${SERVER_NAME:?SERVER_NAME is required}"

REAL="/etc/letsencrypt/live/$SERVER_NAME"
PLACEHOLDER="/etc/nginx/placeholder"
LINK="/etc/nginx/tls"

if [ -s "$REAL/fullchain.pem" ] && [ -s "$REAL/privkey.pem" ]; then
  ln -sfn "$REAL" "$LINK"
  echo "TLS: serving the certificate in $REAL"
  exit 0
fi

# Three days, deliberately. If the real certificate never arrives, this
# expires loudly rather than sitting there looking like TLS for a year.
if [ ! -s "$PLACEHOLDER/fullchain.pem" ]; then
  echo "TLS: no certificate yet, writing a self-signed placeholder for $SERVER_NAME"
  mkdir -p "$PLACEHOLDER"
  openssl req -x509 -newkey rsa:2048 -nodes -days 3 \
    -keyout "$PLACEHOLDER/privkey.pem" \
    -out "$PLACEHOLDER/fullchain.pem" \
    -subj "/CN=$SERVER_NAME" >/dev/null 2>&1
fi

ln -sfn "$PLACEHOLDER" "$LINK"
echo "TLS: serving a placeholder. Run certbot, then: docker compose exec web /usr/local/bin/use-real-cert"
