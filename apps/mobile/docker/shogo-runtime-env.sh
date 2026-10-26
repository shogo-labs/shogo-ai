#!/bin/sh
# Renders deploy-time config into the studio index.html at container start, so
# one web image can be promoted unchanged from staging to production.
#
# Replaces the <!--shogo-runtime-env--> marker left by
# apps/mobile/scripts/inject-analytics.js with:
#   - window.__SHOGO_ENV__ (read by apps/mobile/lib/runtime-env.ts)
#   - GA4 / Facebook Pixel tags, when their IDs are set
#
# Env: SHOGO_APP_ENV, SHOGO_API_URL, SHOGO_APP_VERSION, GA4_MEASUREMENT_ID,
# FB_PIXEL_ID (all optional). Values are interpolated into HTML/JS, so
# anything outside a conservative character set is rejected.
set -eu

HTML="${SHOGO_HTML_PATH:-/usr/share/nginx/html/index.html}"
MARKER='<!--shogo-runtime-env-->'

APP_ENV="${SHOGO_APP_ENV:-}"
API_URL="${SHOGO_API_URL:-}"
APP_VERSION="${SHOGO_APP_VERSION:-}"
GA4="${GA4_MEASUREMENT_ID:-}"
FB="${FB_PIXEL_ID:-}"

require_safe() {
  case "$2" in
    *[!A-Za-z0-9_.:/+-]*)
      echo "shogo-runtime-env: $1 contains unsupported characters; refusing to render" >&2
      exit 1
      ;;
  esac
}
require_safe SHOGO_APP_ENV "$APP_ENV"
require_safe SHOGO_API_URL "$API_URL"
require_safe SHOGO_APP_VERSION "$APP_VERSION"
require_safe GA4_MEASUREMENT_ID "$GA4"
require_safe FB_PIXEL_ID "$FB"

if ! grep -qF "$MARKER" "$HTML"; then
  echo "shogo-runtime-env: no marker in $HTML (already rendered?); leaving it unchanged"
  exit 0
fi

SNIPPET="<script>window.__SHOGO_ENV__={\"appEnv\":\"${APP_ENV}\",\"apiUrl\":\"${API_URL}\",\"appVersion\":\"${APP_VERSION}\"};</script>"

if [ -n "$GA4" ]; then
  SNIPPET="${SNIPPET}<script async src=\"https://www.googletagmanager.com/gtag/js?id=${GA4}\"></script>"
  SNIPPET="${SNIPPET}<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${GA4}');</script>"
fi

if [ -n "$FB" ]; then
  SNIPPET="${SNIPPET}<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${FB}');fbq('track','PageView');</script>"
  SNIPPET="${SNIPPET}<noscript><img height=\"1\" width=\"1\" style=\"display:none\" src=\"https://www.facebook.com/tr?id=${FB}&ev=PageView&noscript=1\"/></noscript>"
fi

TMP="${HTML}.tmp"
SNIPPET="$SNIPPET" awk -v marker="$MARKER" '{
  i = index($0, marker)
  if (i > 0) $0 = substr($0, 1, i - 1) ENVIRON["SNIPPET"] substr($0, i + length(marker))
  print
}' "$HTML" > "$TMP"
mv "$TMP" "$HTML"

echo "shogo-runtime-env: rendered appEnv=${APP_ENV:-<unset>} apiUrl=${API_URL:-<origin>} appVersion=${APP_VERSION:-<build>} ga4=${GA4:+set} fbPixel=${FB:+set}"
