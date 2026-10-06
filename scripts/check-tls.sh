#!/bin/sh
# Prove the certificate being served is the real one.
#
# The failure this exists to catch is quiet. If the self-signed placeholder
# is ever written into certbot's own directory, certbot issues to
# <domain>-0001 and leaves the original in place: the site stays up, nginx
# goes on serving a self-signed certificate, and nothing logs an error.
# Browsers complain and nobody else does.
#
#   ./scripts/check-tls.sh tasks.example.com
set -eu

DOMAIN="${1:-${SERVER_NAME:-}}"
if [ -z "$DOMAIN" ]; then
  echo "Usage: check-tls.sh <domain>" >&2
  exit 2
fi

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# 1. Certbot wrote where it was supposed to
# ---------------------------------------------------------------------------
LIVE="${LETSENCRYPT_DIR:-./certs}/live"

if [ -d "$LIVE" ]; then
  if [ ! -d "$LIVE/$DOMAIN" ]; then
    fail "no $LIVE/$DOMAIN: certbot has not issued for this name"
  fi
  # The whole point of the check.
  for stray in "$LIVE/$DOMAIN"-[0-9][0-9][0-9][0-9]; do
    [ -e "$stray" ] || continue
    fail "found $stray. Certbot refused to use $LIVE/$DOMAIN because something
      else had already written there, so nginx is probably still serving a
      placeholder. Remove the stray directory and the placeholder, then
      reissue."
  done
  echo "ok: $LIVE/$DOMAIN exists and has no -0001 sibling"
fi

# ---------------------------------------------------------------------------
# 2. What is actually on the wire
# ---------------------------------------------------------------------------
CERT="$(echo | openssl s_client -servername "$DOMAIN" -connect "$DOMAIN:443" 2>/dev/null \
  | openssl x509 -noout -issuer -subject -dates 2>/dev/null)" || fail "nothing answered on $DOMAIN:443"

echo "$CERT"

ISSUER="$(printf '%s' "$CERT" | sed -n 's/^issuer=//p')"
SUBJECT="$(printf '%s' "$CERT" | sed -n 's/^subject=//p')"

case "$ISSUER" in
  *"Let's Encrypt"*|*"ISRG"*) ;;
  *)
    # A self-signed placeholder is its own issuer, which is the tell.
    if [ "$ISSUER" = "$SUBJECT" ]; then
      fail "the certificate is self-signed: this is the placeholder, not a real one"
    fi
    fail "unexpected issuer: $ISSUER"
    ;;
esac

echo "ok: $DOMAIN is serving a Let's Encrypt certificate"

# ---------------------------------------------------------------------------
# 3. And HTTP goes to HTTPS
# ---------------------------------------------------------------------------
CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://$DOMAIN/" || echo 000)"
case "$CODE" in
  301|308) echo "ok: http redirects ($CODE)" ;;
  *) fail "http://$DOMAIN/ returned $CODE, expected a redirect to https" ;;
esac
