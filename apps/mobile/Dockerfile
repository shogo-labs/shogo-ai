# syntax=docker/dockerfile:1.7-labs
# =============================================================================
# Shogo Web Frontend Dockerfile (Expo Web Export)
# =============================================================================
# Phase B refactor: builder is now FROM the pre-baked shogo-workspace-deps
# image (debian, bun, full install + build:packages applied). We just COPY
# in apps/mobile and run expo export.
#
# Production stage is unchanged: nginx-alpine serving the exported static
# files. The builder stage's libc doesn't matter for production because the
# only thing that crosses the boundary is the JS/CSS/HTML bundle.
# =============================================================================

ARG WORKSPACE_DEPS

FROM ${WORKSPACE_DEPS} AS builder

WORKDIR /app

ARG EXPO_PUBLIC_API_URL=
ARG EXPO_PUBLIC_BUILD_HASH=dev
ARG EXPO_PUBLIC_APP_ENV=development
# Per-platform Sentry DSN. The mobile-web bundle reads
# `process.env.EXPO_PUBLIC_SENTRY_DSN_WEB` at runtime (see
# apps/mobile/app/_layout.tsx). The desktop renderer image (which is also
# built FROM this stage) overrides this ARG with its own DSN so renderer
# events land in the `shogo-desktop` project instead of `javascript-react`.
ARG EXPO_PUBLIC_SENTRY_DSN_WEB=
ARG GA4_MEASUREMENT_ID=
ARG FB_PIXEL_ID=
ARG SENTRY_AUTH_TOKEN=
ARG SENTRY_ORG=shogo-ai
ARG SENTRY_PROJECT=javascript-react
ENV EXPO_PUBLIC_API_URL=$EXPO_PUBLIC_API_URL
ENV EXPO_PUBLIC_BUILD_HASH=$EXPO_PUBLIC_BUILD_HASH
ENV EXPO_PUBLIC_APP_ENV=$EXPO_PUBLIC_APP_ENV
ENV EXPO_PUBLIC_SENTRY_DSN_WEB=$EXPO_PUBLIC_SENTRY_DSN_WEB
ENV EXPO_PUBLIC_GA4_ID=$GA4_MEASUREMENT_ID
ENV EXPO_PUBLIC_FB_PIXEL_ID=$FB_PIXEL_ID
ENV SENTRY_AUTH_TOKEN=$SENTRY_AUTH_TOKEN
ENV SENTRY_ORG=$SENTRY_ORG
ENV SENTRY_PROJECT=$SENTRY_PROJECT
# The Metro serializer (getSentryExpoConfig) only needs to inject Debug IDs
# and write source maps here — the actual upload is the explicit sentry-cli
# step below. Disable the serializer's auto-upload path so we keep a single,
# controlled upload to the right project.
ENV SENTRY_DISABLE_AUTO_UPLOAD=true

# Sentry CLI standalone binary. The get-cli/ install script doesn't reliably
# land sentry-cli in PATH on this debian base, so download the prebuilt
# arm64 binary directly. Installed as root so it lands in /usr/local/bin
# (workspace's USER is appuser).
USER root
RUN curl -fsSL "https://github.com/getsentry/sentry-cli/releases/download/3.3.4/sentry-cli-Linux-aarch64" \
        -o /usr/local/bin/sentry-cli && \
    chmod +x /usr/local/bin/sentry-cli
USER appuser

# apps/mobile source — workspace-deps does not bake this in (workspace-deps
# only bakes apps/api source because that's the only one needing
# generate:routes). Mobile source is shallow enough to copy directly.
COPY --chown=appuser:appgroup apps/mobile ./apps/mobile

# Mirror Monaco's self-hosted AMD bundle (node_modules/monaco-editor/min/vs)
# into public/vs BEFORE exporting. `expo export` copies public/ into dist/,
# so this is what lands `dist/vs/loader.js` at the same origin as the app
# shell. CodeEditor.tsx pins `@monaco-editor/loader` at `/vs` (not the CDN)
# to satisfy the desktop CSP and work offline — if /vs is missing, the
# loader's `/vs/loader.js` request falls through nginx's SPA fallback to
# index.html, the browser gets HTML for a <script>, and Monaco fails with
# "Monaco initialization: error: Event" (blank IDE editors). The `build` npm
# script chains this same step; the Docker build must not drift from it.
WORKDIR /app/apps/mobile
RUN node scripts/copy-monaco-vs.mjs

# Build Expo web export (Metro bundler outputs to apps/mobile/dist/).
# packages/*/dist are already pre-built in workspace-deps.
RUN npx expo export --platform web

# Fail the build loudly if the self-hosted Monaco bundle didn't make it into
# the export. Mirrors the integrity guard in apps/desktop/scripts/sync-web.mjs
# so we never ship a Monaco-less web image again (the blank-IDE / "Monaco
# initialization: error: Event" regression). Catches both a skipped copy step
# AND a future Expo upgrade that stops copying public/ into dist/.
RUN test -f dist/vs/loader.js && test -f dist/vs/editor/editor.main.js \
    || (echo "ERROR: Monaco /vs assets missing from dist/ — IDE editors would be blank. Did scripts/copy-monaco-vs.mjs run and did expo export copy public/?" && exit 1)

# Inject analytics scripts into the exported HTML (Expo "single" mode strips
# <script> tags from +html.tsx, so we inject them post-export).
RUN node scripts/inject-analytics.js

# Upload source maps to Sentry (inject debug IDs, upload, then strip maps).
# When SENTRY_AUTH_TOKEN is set (real deploys) a failed upload FAILS the
# build: shipping a minified bundle whose maps never reached Sentry silently
# breaks symbolication for the whole release (this is exactly how
# `production_web` issues like `Object.S` / `Qr` went unreadable), so a loud
# failure is the lesser evil.
#
# An EMPTY token on a *production* build (EXPO_PUBLIC_APP_ENV starts with
# `production`) is the regression that actually shipped: the token wasn't
# configured for the deploy environment, the whole block was skipped, and
# every production_web event stayed minified while `.map` files were left
# undeleted (and publicly served). Fail loudly in that case too. Fork /
# contributor builds (non-production) without the token still skip and stay
# telemetry-free.
RUN if [ -n "$SENTRY_AUTH_TOKEN" ]; then \
      sentry-cli sourcemaps inject --release "$EXPO_PUBLIC_BUILD_HASH" ./dist && \
      sentry-cli sourcemaps upload --org "$SENTRY_ORG" --project "$SENTRY_PROJECT" --release "$EXPO_PUBLIC_BUILD_HASH" ./dist && \
      find ./dist -name '*.map' -delete; \
    elif [ "${EXPO_PUBLIC_APP_ENV#production}" != "$EXPO_PUBLIC_APP_ENV" ]; then \
      echo "ERROR: SENTRY_AUTH_TOKEN is empty on a production build (EXPO_PUBLIC_APP_ENV=$EXPO_PUBLIC_APP_ENV)." >&2; \
      echo "Refusing to ship a web bundle whose source maps never reach Sentry — production_web issues would be unsymbolicated and .map files would leak publicly. Configure SENTRY_AUTH_TOKEN (project:releases scope) for this deploy environment." >&2; \
      exit 1; \
    else \
      echo "SENTRY_AUTH_TOKEN not set — skipping Sentry source map upload (non-production build)"; \
    fi

# =============================================================================
# Production image with Nginx
# =============================================================================
FROM nginx:alpine

ENV API_UPSTREAM=http://shogo-api.shogo-system.svc.cluster.local:8002
ENV API_HOST=shogo-api.shogo-system.svc.cluster.local
ENV DNS_RESOLVER=kube-dns.kube-system.svc.cluster.local

COPY --from=builder /app/apps/mobile/dist /usr/share/nginx/html

COPY apps/mobile/nginx.conf /etc/nginx/nginx.conf.template

EXPOSE 80

CMD ["/bin/sh", "-c", "envsubst '${API_UPSTREAM} ${API_HOST} ${DNS_RESOLVER}' < /etc/nginx/nginx.conf.template > /etc/nginx/conf.d/default.conf && nginx -g 'daemon off;'"]
