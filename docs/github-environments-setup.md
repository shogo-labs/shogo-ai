# GitHub Environments Setup for Multi-Region OCI Deployment

## Overview

The CI/CD pipeline uses GitHub Environments to scope secrets and variables per region.
For staging, a single `staging` environment is used.
For production, there are **5 environments**: one per region + the primary build environment.

## Environments

| Environment | Purpose | Region |
|---|---|---|
| `staging` | Staging (single region) | us-ashburn-1 |
| `production-us` | Production primary (US) - builds images, runs migrations | us-ashburn-1 |
| `production-eu` | Production EU (Tier 1 replica) | eu-frankfurt-1 |
| `production-india` | Production India (Tier 2 edge) | ap-mumbai-1 |

## Variables (per environment)

These are **non-secret** configuration values.

| Variable | staging | production-us | production-eu | production-india |
|---|---|---|---|---|
| `OCI_REGION` | us-ashburn-1 | us-ashburn-1 | eu-frankfurt-1 | ap-mumbai-1 |
| `OCI_TENANCY_NAMESPACE` | idin4oltblww | idin4oltblww | idin4oltblww | idin4oltblww |
| `OKE_CLUSTER_OCID` | (staging cluster) | (US cluster) | (EU cluster) | (India cluster) |
| `NODE_POOL_OCID` | (staging pool) | (US pool) | (EU pool) | (India pool) |
| `NAMESPACE_SYSTEM` | shogo-staging-system | shogo-production-system | shogo-production-system | shogo-production-system |
| `NAMESPACE_WORKSPACES` | shogo-staging-workspaces | shogo-production-workspaces | shogo-production-workspaces | shogo-production-workspaces |
| `DOMAIN` | studio.staging.shogo.ai | studio.shogo.ai | studio.shogo.ai | studio.shogo.ai |
| `DOCS_DOMAIN` | docs.staging.shogo.ai | docs.shogo.ai | docs.shogo.ai | docs.shogo.ai |
| `ALLOWED_ORIGINS` | https://studio.staging.shogo.ai | https://studio.shogo.ai | https://studio.shogo.ai | https://studio.shogo.ai |
| `EXPO_PUBLIC_API_URL` | https://studio.staging.shogo.ai | https://studio.shogo.ai | https://studio.shogo.ai | https://studio.shogo.ai |

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
| `STRIPE_SECRET_KEY` | Stripe API key |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |
| `GH_APP_ID` | GitHub App ID |
| `GH_APP_CLIENT_ID` | GitHub App OAuth client ID |
| `GH_APP_CLIENT_SECRET` | GitHub App OAuth client secret |
| `GH_APP_PRIVATE_KEY` | GitHub App private key |
| `GH_APP_WEBHOOK_SECRET` | GitHub App webhook secret |
| `GH_APP_SLUG` | GitHub App slug |
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

## Quick Setup

1. Go to GitHub repo → Settings → Environments
2. Create each environment listed above
3. For each environment, add:
   - The OCI variables from the Variables table (use the actual OKE cluster OCIDs after provisioning)
   - The OCI credential secrets
   - The application secrets (or configure at org level)
4. The `production` branch triggers the production pipeline
5. The `staging` branch triggers the staging pipeline
