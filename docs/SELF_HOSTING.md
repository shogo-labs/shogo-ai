# Self-Hosting Shogo

This guide covers the public self-hosted version of Shogo.

## Licensing

Before deploying, understand the license split:

- Core Shogo application code is `AGPL-3.0-or-later`
- `packages/sdk/` and SDK examples are `Apache-2.0`
- Infrastructure materials in `terraform/`, `k8s/`, `deploy-examples/`, and
  `.github/workflows/` are proprietary under `INFRASTRUCTURE-LICENSE.md`

## Deployment Modes

### 1. Local development

Best for hacking on the product locally with Docker-managed infrastructure.

### 2. Single-tenant self-hosted deployment

Best for internal team usage on your own cloud or Kubernetes cluster.

### 3. Desktop/local mode

Best for fully local, offline-first use. See `apps/desktop/README.md`.

## Minimum Requirements

- Bun
- Node.js
- Docker for local development
- PostgreSQL
- Redis
- S3-compatible object storage such as MinIO or AWS S3
- At least one AI provider key such as `ANTHROPIC_API_KEY`

## Required Environment Variables

At minimum, configure:

```bash
DATABASE_URL=postgres://...
PROJECTS_DATABASE_URL=postgres://...
REDIS_URL=redis://...
BETTER_AUTH_SECRET=replace-with-a-long-random-secret
BETTER_AUTH_URL=https://your-auth-origin
ALLOWED_ORIGINS=https://your-frontend-origin
EXPO_PUBLIC_API_URL=https://your-api-origin
S3_ENDPOINT=https://your-s3-endpoint
S3_PUBLIC_ENDPOINT=https://your-public-s3-endpoint
S3_WORKSPACES_BUCKET=shogo-workspaces
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
ANTHROPIC_API_KEY=...
```

See `.env.example` for the full configuration surface.

## Local Development Setup

1. Install dependencies.

```bash
bun install
```

2. Create your env file.

```bash
cp .env.example .env.local
```

3. Start infrastructure.

```bash
bun run docker:infra
```

4. Apply migrations.

```bash
bun run db:migrate:deploy
```

5. Start the app.

```bash
bun run dev:all
```

The app will be available at `http://localhost:8081`.

## Optional Integrations

These are not required for a basic self-hosted deployment:

- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and the `STRIPE_PRICE_*` matrix
  for billing
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` for Google sign-in
- `COMPOSIO_API_KEY` and related auth config for third-party integrations
- `SERPER_API_KEY` for web search
- SMTP or SES configuration for outgoing email
- OTEL / SigNoz variables for observability

## Storage Notes

Shogo expects S3-compatible storage for schemas and workspace assets in normal
server mode. For local development, MinIO is the easiest option.

If you use MinIO locally, set:

```bash
S3_FORCE_PATH_STYLE=true
S3_ENDPOINT=http://localhost:9000
S3_PUBLIC_ENDPOINT=http://localhost:9000
AWS_ACCESS_KEY_ID=minioadmin
AWS_SECRET_ACCESS_KEY=minioadmin
```

## Billing Notes

Billing is optional for self-hosting.

If you enable Stripe, you must configure:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- The matching `STRIPE_PRICE_STAGING_*` or `STRIPE_PRICE_PRODUCTION_*`
  environment variables for the plans you expose

If those values are unset, billing flows should be considered disabled or
incomplete.

## Authentication Notes

- `BETTER_AUTH_SECRET` must be set to a strong secret in production
- `BETTER_AUTH_URL` should point to the public auth/API origin
- `AI_PROXY_SECRET` and `PREVIEW_TOKEN_SECRET` are optional overrides; if not
  set, the app falls back to `BETTER_AUTH_SECRET`

## Infrastructure Notes

The infrastructure examples in this repository are sanitized and incomplete by
design. Hosted Shogo Cloud infrastructure is not open sourced.

Use the files in `deploy-examples/` as a starting point, then maintain your
real deployment configuration privately.

## Security Checklist

- Rotate all secrets before first production deployment
- Do not commit `.env.local` or real credentials
- Replace placeholder Kubernetes secrets before deploying
- Restrict access to Redis, PostgreSQL, and object storage
- Enable TLS for all public endpoints
- Keep runtime and dependency versions up to date

## Troubleshooting

### App loads but auth fails

Check `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, and `ALLOWED_ORIGINS`.

### Project previews fail

Check `PROJECTS_DATABASE_URL`, S3 configuration, and runtime port settings.

### Agent calls fail

Check `ANTHROPIC_API_KEY` or your configured local/OpenAI-compatible model
settings.

### Billing errors

Check the relevant `STRIPE_*` environment variables and webhook configuration.
