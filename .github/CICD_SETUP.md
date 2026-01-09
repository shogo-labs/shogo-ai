# CI/CD Setup Guide

This guide explains how to configure the GitHub Actions workflow for automatic build, test, and deployment to multiple environments.

## Multi-Environment Architecture

The pipeline supports two environments with automatic branch-based deployment:

| Branch | Environment | Domains |
|--------|-------------|---------|
| `staging` | Staging | `api-staging.shogo.ai`, `studio-staging.shogo.ai` |
| `main` | Production | `api.shogo.ai`, `studio.shogo.ai` |

## Prerequisites

1. AWS Infrastructure deployed via Terraform (see `terraform/environments/production/`)
2. GitHub repository with Actions enabled
3. Two EKS clusters: `shogo-staging` and `shogo-production`
4. DNS records configured for both staging and production domains

## Step 1: Deploy Infrastructure with GitHub OIDC

Update your `terraform.tfvars` with your GitHub organization/username:

```hcl
github_org  = "your-github-username-or-org"
github_repo = "shogo-ai"
```

Then apply Terraform:

```bash
cd terraform/environments/production
terraform apply
```

After applying, note the output:
```
github_actions_role_arn = "arn:aws:iam::ACCOUNT_ID:role/shogo-github-actions"
```

## Step 2: Configure GitHub Environments

Create **two GitHub Environments** in your repository: `staging` and `production`.

Go to **Settings > Environments** and create each environment.

### Staging Environment

Go to **Settings > Environments > staging** and configure:

#### Secrets (sensitive values - masked in logs)

| Secret Name | Value | Description |
|-------------|-------|-------------|
| `AWS_ROLE_ARN` | `arn:aws:iam::ACCOUNT_ID:role/shogo-github-actions` | From Terraform output |

#### Variables (non-sensitive config - visible in logs)

| Variable Name | Value | Description |
|---------------|-------|-------------|
| `VITE_API_URL` | `https://api-staging.shogo.ai` | Staging API endpoint |
| `VITE_MCP_URL` | `https://mcp-staging.shogo.ai` | Staging MCP endpoint |
| `VITE_BETTER_AUTH_URL` | `https://api-staging.shogo.ai` | Staging Auth endpoint |
| `VITE_WORKSPACE` | `workspace-1` | Default workspace ID |
| `ALLOWED_ORIGINS` | `https://studio-staging.shogo.ai,https://api-staging.shogo.ai` | CORS allowed origins |

### Production Environment

Go to **Settings > Environments > production** and configure:

#### Secrets

| Secret Name | Value | Description |
|-------------|-------|-------------|
| `AWS_ROLE_ARN` | `arn:aws:iam::ACCOUNT_ID:role/shogo-github-actions` | From Terraform output |

#### Variables

| Variable Name | Value | Description |
|---------------|-------|-------------|
| `VITE_API_URL` | `https://api.shogo.ai` | Production API endpoint |
| `VITE_MCP_URL` | `https://mcp.shogo.ai` | Production MCP endpoint |
| `VITE_BETTER_AUTH_URL` | `https://api.shogo.ai` | Production Auth endpoint |
| `VITE_WORKSPACE` | `workspace-1` | Default workspace ID |
| `ALLOWED_ORIGINS` | `https://studio.shogo.ai,https://api.shogo.ai,https://shogo.ai` | CORS allowed origins |

> **Note:** `VITE_BETTER_AUTH_URL` should be the same as `VITE_API_URL` since BetterAuth is integrated into the API server.

## Step 3: Configure EKS Access

The GitHub Actions role needs to be added to **both** EKS clusters' aws-auth ConfigMap.

### For shogo-staging cluster:

```bash
eksctl create iamidentitymapping \
  --cluster shogo-staging \
  --region us-east-2 \
  --arn arn:aws:iam::ACCOUNT_ID:role/shogo-github-actions \
  --username github-actions \
  --group system:masters
```

### For shogo-production cluster:

```bash
eksctl create iamidentitymapping \
  --cluster shogo-production \
  --region us-east-2 \
  --arn arn:aws:iam::ACCOUNT_ID:role/shogo-github-actions \
  --username github-actions \
  --group system:masters
```

## Step 4: Test the Workflow

### Automatic Deployment

1. Push to `staging` branch → Deploys to staging environment
2. Push to `main` branch → Deploys to production environment

### Manual Deployment

You can manually trigger deployment to any environment:

1. Go to **Actions** tab in GitHub
2. Select "Build, Test, and Deploy" workflow
3. Click "Run workflow"
4. Select the target environment (staging or production)

## Pipeline Stages

| Stage | Description |
|-------|-------------|
| **setup** | Determines target environment from branch or manual input |
| **test** | Runs `bun test` and type checks |
| **build-and-push** | Builds and pushes Docker images to ECR with environment tags |
| **deploy** | Applies Kustomize overlays and updates Knative services |

## Kubernetes Overlay Structure

The pipeline uses Kustomize overlays for environment-specific configuration:

```
k8s/
├── base/                    # Shared base configurations
├── overlays/
│   ├── staging/            # Staging-specific configs
│   │   ├── kustomization.yaml
│   │   ├── namespace.yaml
│   │   ├── domain-mappings.yaml
│   │   ├── api-service.yaml
│   │   ├── web-service.yaml
│   │   └── workspace-services.yaml
│   └── production/         # Production-specific configs
│       ├── kustomization.yaml
│       ├── namespace.yaml
│       ├── domain-mappings.yaml
│       ├── api-service.yaml
│       ├── web-service.yaml
│       └── workspace-services.yaml
└── eks/                    # Legacy (kept for compatibility)
```

## Image Tagging Strategy

Images are tagged with environment prefix for clear identification:

| Environment | Tag Format | Example |
|-------------|------------|---------|
| Staging | `staging-<sha>` | `staging-abc123` |
| Production | `production-<sha>` | `production-abc123` |

Additionally, each environment maintains a `<env>-latest` tag for the most recent build.

## Domain Configuration

### Staging Domains
- **Studio**: `https://studio-staging.shogo.ai`
- **API**: `https://api-staging.shogo.ai`
- **MCP**: `https://mcp-staging.shogo.ai`

### Production Domains
- **Studio**: `https://studio.shogo.ai`
- **API**: `https://api.shogo.ai`
- **MCP**: `https://mcp.shogo.ai`

## Namespace Isolation

Each environment uses separate Kubernetes namespaces:

| Environment | System Namespace | Workspaces Namespace |
|-------------|------------------|----------------------|
| Staging | `shogo-staging-system` | `shogo-staging-workspaces` |
| Production | `shogo-system` | `shogo-workspaces` |

## Troubleshooting

### ECR Login Failed
- Verify `AWS_ROLE_ARN` is correct in the environment secrets
- Check that the IAM role has ECR permissions

### EKS Deploy Failed
- Ensure the GitHub Actions role is mapped in aws-auth ConfigMap for the target cluster
- Check that the role has EKS describe permissions
- Verify the correct cluster name is being used

### Image Build Failed
- Check Dockerfile syntax
- Ensure all dependencies are available

### Wrong Environment Deployed
- Verify branch protection rules are in place
- Check the workflow trigger conditions
- Manual deployments require explicit environment selection

## Security Notes

- Uses OIDC authentication (no long-lived AWS credentials)
- Images are scanned on push to ECR
- Role permissions are scoped to specific ECR repos and EKS clusters
- Environment-specific secrets are isolated in GitHub Environments
- Production environment can have additional protection rules (required reviewers, etc.)

## Adding Environment Protection Rules (Recommended for Production)

In **Settings > Environments > production**, consider enabling:

- **Required reviewers**: Require approval before deploying
- **Wait timer**: Add a delay before deployment
- **Deployment branches**: Restrict to `main` branch only
