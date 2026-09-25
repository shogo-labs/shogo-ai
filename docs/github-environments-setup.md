# GitHub Environments Setup for Multi-Region OCI Deployment

## Overview

The CI/CD pipeline uses GitHub Environments to scope secrets and variables per region.
For staging, a single `staging` environment is used.
For production, there is one environment per active region (`production-us`,
`production-eu`); `production-us` doubles as the primary build/migration
environment.

> The `production-india` environment (`ap-mumbai-1`) was retired on 2026-07-07
> when India was decommissioned (India → EU migration). Delete it and its
> variables/secrets under repo Settings → Environments.

## Environments

| Environment | Purpose | Region |
|---|---|---|
| `staging` | Staging (single region) | us-ashburn-1 |
| `production-us` | Production primary (US) - builds images, runs migrations | us-ashburn-1 |
| `production-eu` | Production EU (Tier 1 replica) | eu-frankfurt-1 |

## Variables (per environment)

These are **non-secret** configuration values.

| Variable | staging | production-us | production-eu |
|---|---|---|---|
| `OCI_REGION` | us-ashburn-1 | us-ashburn-1 | eu-frankfurt-1 |
| `OCI_TENANCY_NAMESPACE` | idin4oltblww | idin4oltblww | idin4oltblww |
| `OKE_CLUSTER_OCID` | (staging cluster) | (US cluster) | (EU cluster) |
| `NODE_POOL_OCID` | (staging pool) | (US pool) | (EU pool) |
| `NAMESPACE_SYSTEM` | shogo-staging-system | shogo-production-system | shogo-production-system |
| `NAMESPACE_WORKSPACES` | shogo-staging-workspaces | shogo-production-workspaces | shogo-production-workspaces |
| `DOMAIN` | studio.staging.shogo.ai | studio.shogo.ai | studio.shogo.ai |
| `DOCS_DOMAIN` | docs.staging.shogo.ai | docs.shogo.ai | docs.shogo.ai |
| `ALLOWED_ORIGINS` | https://studio.staging.shogo.ai | https://studio.shogo.ai | https://studio.shogo.ai |
| `EXPO_PUBLIC_API_URL` | https://studio.staging.shogo.ai | https://studio.shogo.ai | https://studio.shogo.ai |

## Secrets (per environment)

### OCI Credentials (unique per region if using separate API keys, or shared)

| Secret | Description |
|---|---|
| `OCI_USER_OCID` | OCI user OCID |
| `OCI_TENANCY_OCID` | OCI tenancy OCID |
| `OCI_FINGERPRINT` | API key fingerprint |
| `OCI_PRIVATE_KEY` | API private key (PEM content) |
| `OCI_AUTH_TOKEN` | OCIR auth token |
| `OCI_USERNAME` | OCIR login username (e.g. info@shogo.ai) |

### Application Secrets (same across all environments)

These should ideally be set as **organization-level secrets** to avoid duplication:

| Secret | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic Claude API key |
| `BETTER_AUTH_SECRET` | Better Auth session secret |
| `SECRETS_ENCRYPTION_KEY` | AES-256-GCM master key (base64, 32 bytes) for encrypting model-provider API keys at rest. **Must be identical across all regions sharing the primary DB** (production-us/eu) so encrypted rows decrypt everywhere; staging uses its own. Generate with `openssl rand -base64 32`. |
| `STRIPE_SECRET_KEY` | Stripe API key |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `SERPER_API_KEY` | Serper web search API key |
| `COMPOSIO_API_KEY` | Composio API key |
| `COMPOSIO_PROJECT_ID` | Composio project ID |
| `OPENAI_API_KEY` | OpenAI API key |
| `GOOGLE_API_KEY` | Google AI API key |
| `SIGNOZ_INGESTION_KEY` | SigNoz OTEL ingestion key |
| `LOAD_TEST_SECRET` | Rate limit bypass key for load testing |
| `VITE_GTM_ID` | Google Tag Manager ID (production only) |

### GitHub App Secrets (per environment)

The GitHub App credentials are environment-specific. Use one app for both
production regions, and a separate app for staging.

| Secret | `staging` | `production-us` | `production-eu` |
|---|---|---|---|
| `GH_APP_ID` | Staging app | Production app | Production app |
| `GH_APP_CLIENT_ID` | Staging app | Production app | Production app |
| `GH_APP_CLIENT_SECRET` | Staging app | Production app | Production app |
| `GH_APP_PRIVATE_KEY` | Staging app | Production app | Production app |
| `GH_APP_WEBHOOK_SECRET` | Staging app | Production app | Production app |
| `GH_APP_SLUG` | Staging app slug | Production app slug | Production app slug |

## Creating the GitHub Apps

Run the manifest-flow helper from the repository root after authenticating the
GitHub CLI with access to `shogo-labs/shogo-ai`:

```bash
bun scripts/create-github-app.ts --env staging
bun scripts/create-github-app.ts --env production
```

The helper opens GitHub's organization app-registration page, waits for the
registration callback on localhost, converts the manifest, and stores the
returned credentials in the appropriate GitHub Actions environment secrets.
Production writes the same credentials to both `production-us` and
`production-eu`. It also saves a mode-600 private-key backup under
`~/.shogo/github-apps/`.

The production app uses `https://studio.shogo.ai`; the staging app uses
`https://studio.staging.shogo.ai`. Both apps deliver signed webhooks to
`/api/github/webhook`. Install the resulting app on each GitHub account or
organization whose repositories Shogo should access.

Local development continues to use `shogo-dev-ai`, owned by `lacvapps`, with
localhost URLs. Keep those credentials in `.env.local`; do not copy them into
the staging or production GitHub environments.

## Quick Setup

1. Go to GitHub repo → Settings → Environments
2. Create each environment listed above
3. For each environment, add:
   - The OCI variables from the Variables table (use the actual OKE cluster OCIDs after provisioning)
   - The OCI credential secrets
   - The application secrets (or configure at org level)
4. The `production` branch triggers the production pipeline
5. The `staging` branch triggers the staging pipeline
