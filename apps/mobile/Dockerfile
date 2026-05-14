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
ARG EXPO_PUBLIC_SENTRY_DSN=
ARG GA4_MEASUREMENT_ID=
ARG FB_PIXEL_ID=
ARG SENTRY_AUTH_TOKEN=
ARG SENTRY_ORG=shogo
ARG SENTRY_PROJECT=shogo-mobile
ENV EXPO_PUBLIC_API_URL=$EXPO_PUBLIC_API_URL
ENV EXPO_PUBLIC_BUILD_HASH=$EXPO_PUBLIC_BUILD_HASH
ENV EXPO_PUBLIC_APP_ENV=$EXPO_PUBLIC_APP_ENV
ENV EXPO_PUBLIC_SENTRY_DSN=$EXPO_PUBLIC_SENTRY_DSN
ENV EXPO_PUBLIC_GA4_ID=$GA4_MEASUREMENT_ID
ENV EXPO_PUBLIC_FB_PIXEL_ID=$FB_PIXEL_ID
ENV SENTRY_AUTH_TOKEN=$SENTRY_AUTH_TOKEN
ENV SENTRY_ORG=$SENTRY_ORG
ENV SENTRY_PROJECT=$SENTRY_PROJECT

# Sentry CLI standalone binary (statically linked, works on glibc/musl).
# Installed as root so it lands in /usr/local/bin (workspace's USER is appuser).
USER root
RUN curl -sL https://sentry.io/get-cli/ | SENTRY_CLI_VERSION="3.3.4" sh
USER appuser

# apps/mobile source — workspace-deps does not bake this in (workspace-deps
# only bakes apps/api source because that's the only one needing
# generate:routes). Mobile source is shallow enough to copy directly.
COPY --chown=appuser:appgroup apps/mobile ./apps/mobile

# Build Expo web export (Metro bundler outputs to apps/mobile/dist/).
# packages/*/dist are already pre-built in workspace-deps.
WORKDIR /app/apps/mobile
RUN npx expo export --platform web

# Inject analytics scripts into the exported HTML (Expo "single" mode strips
# <script> tags from +html.tsx, so we inject them post-export).
RUN node scripts/inject-analytics.js

# Upload source maps to Sentry (inject debug IDs, upload, then strip maps).
# Upload is non-fatal: a Sentry misconfiguration should not block a deploy.
RUN if [ -n "$SENTRY_AUTH_TOKEN" ]; then \
      sentry-cli sourcemaps inject --release "$EXPO_PUBLIC_BUILD_HASH" ./dist && \
      (sentry-cli sourcemaps upload --org "$SENTRY_ORG" --project "$SENTRY_PROJECT" --release "$EXPO_PUBLIC_BUILD_HASH" ./dist \
        || echo "Warning: Sentry sourcemaps upload failed — continuing build") && \
      find ./dist -name '*.map' -delete; \
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
