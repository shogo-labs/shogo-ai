# GitHub Actions Environment Variables

The deploy workflow uses **GitHub environment-scoped variables**. Create
`staging`, `production-us`, `production-eu`, and `production-india` environments
in your repo settings and set the following variables on each.

## Per-Environment Variables

Set these on **all** environments with the appropriate values for each:

- `OCIR_REGISTRY` - OCI Container Registry URL, e.g. `us-ashburn-1.ocir.io/namespace`
- `OKE_CLUSTER` - OKE cluster OCID
- `OCI_REGION` - OCI region, e.g. `us-ashburn-1`
- `NAMESPACE_SYSTEM` - K8s namespace for system services
- `NAMESPACE_WORKSPACES` - K8s namespace for workspace pods
- `DOMAIN` - Primary domain (e.g. `studio.shogo.ai`)
- `DOCS_DOMAIN` - Docs domain (e.g. `docs.shogo.ai`)
- `MULTI_REGION` - `true` or `false`
- `ALLOWED_ORIGINS` - Comma-separated allowed CORS origins
- `EXPO_PUBLIC_API_URL` - Public API URL for web builds

## Related GitHub Secrets

These are not repository variables, but the workflows also rely on standard
GitHub secrets such as:

- `ANTHROPIC_API_KEY`
- `BETTER_AUTH_SECRET`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_API_KEY`
- `OPENAI_API_KEY`
- `SIGNOZ_INGESTION_KEY`
- `KOURIER_TLS_CERT`
- `KOURIER_TLS_KEY`
