# GitHub Actions Repository / Environment Variables

The deploy workflows expect the following GitHub repository or environment
variables to be configured.

## Shared

- `ECR_REGISTRY` - Example: `123456789012.dkr.ecr.us-east-1.amazonaws.com`
- `MOBILE_API_URL` - Public API/studio URL used by mobile release builds

## Staging

- `STAGING_EKS_CLUSTER`
- `STAGING_NAMESPACE_SYSTEM`
- `STAGING_NAMESPACE_WORKSPACES`
- `STAGING_DOMAIN`
- `STAGING_DOCS_DOMAIN`

## Production

- `PROD_EKS_CLUSTER`
- `PROD_EKS_CLUSTER_EU`
- `PROD_NAMESPACE_SYSTEM`
- `PROD_NAMESPACE_WORKSPACES`
- `PROD_DOMAIN`
- `PROD_DOCS_DOMAIN`

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
