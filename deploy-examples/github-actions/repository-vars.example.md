# GitHub Actions Environment Variables

The deploy workflow uses **GitHub environment-scoped variables**. Create a
`staging` and `production` environment in your repo settings and set the
following variables on each.

## Per-Environment Variables

Set these on **both** `staging` and `production` environments with the
appropriate values for each:

- `ECR_REGISTRY` - ECR registry URL, e.g. `123456789012.dkr.ecr.us-east-1.amazonaws.com`
- `EKS_CLUSTER` - EKS cluster name
- `NAMESPACE_SYSTEM` - K8s namespace for system services
- `NAMESPACE_WORKSPACES` - K8s namespace for workspace pods
- `DOMAIN` - Primary domain (e.g. `studio-staging.example.com`)
- `DOCS_DOMAIN` - Docs domain (e.g. `docs-staging.example.com`)
- `MULTI_REGION` - `true` or `false`
- `ALLOWED_ORIGINS` - Comma-separated allowed CORS origins
- `EXPO_PUBLIC_API_URL` - Public API URL for web builds

Set these only on the **production** environment:

- `EKS_CLUSTER_EU` - EU region EKS cluster name (when `MULTI_REGION=true`)

## Related GitHub Secrets

These are not repository variables, but the workflows also rely on standard
GitHub secrets such as:

- `AWS_ROLE_ARN`
- `ANTHROPIC_API_KEY`
- `BETTER_AUTH_SECRET`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `COMPOSIO_API_KEY`
- `COMPOSIO_PROJECT_ID`
- `SERPER_API_KEY`
