# CI/CD Setup Guide

This guide explains how to configure the GitHub Actions workflow for automatic build, test, and deployment.

## Prerequisites

1. AWS Infrastructure deployed via Terraform (see `terraform/environments/production/`)
2. GitHub repository with Actions enabled

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

## Step 2: Configure GitHub Secrets and Variables

In your GitHub repository, go to **Settings > Secrets and variables > Actions**.

### Secrets (sensitive values - masked in logs)

| Secret Name | Value | Description |
|-------------|-------|-------------|
| `AWS_ROLE_ARN` | `arn:aws:iam::ACCOUNT_ID:role/shogo-github-actions` | From Terraform output |

### Variables (non-sensitive config - visible in logs)

Click the **Variables** tab and add:

| Variable Name | Value | Description |
|---------------|-------|-------------|
| `VITE_API_URL` | `https://api.your-domain.com` | API endpoint URL |
| `VITE_MCP_URL` | `https://mcp.your-domain.com` | MCP endpoint URL |
| `VITE_BETTER_AUTH_URL` | `https://api.your-domain.com` | Auth endpoint URL (same as API - BetterAuth runs in API server) |
| `VITE_WORKSPACE` | `default` | Default workspace ID |

> **Note:** `VITE_BETTER_AUTH_URL` should be the same as `VITE_API_URL` since BetterAuth is integrated into the API server.

## Step 3: Configure EKS Access

The GitHub Actions role needs to be added to the EKS cluster's aws-auth ConfigMap to deploy workloads.

Run this command (with your AWS credentials):

```bash
kubectl edit configmap aws-auth -n kube-system
```

Add the following to the `mapRoles` section:

```yaml
mapRoles: |
  - rolearn: arn:aws:iam::ACCOUNT_ID:role/shogo-github-actions
    username: github-actions
    groups:
      - system:masters
```

Alternatively, use eksctl:

```bash
eksctl create iamidentitymapping \
  --cluster shogo-production \
  --region us-east-2 \
  --arn arn:aws:iam::ACCOUNT_ID:role/shogo-github-actions \
  --username github-actions \
  --group system:masters
```

## Step 4: Test the Workflow

1. Push a commit to the `main` branch
2. Go to **Actions** tab in GitHub to watch the workflow
3. The workflow will:
   - Run tests
   - Build Docker images for linux/amd64
   - Push images to ECR
   - Deploy to EKS

## Workflow Stages

| Stage | Description |
|-------|-------------|
| **test** | Runs `bun test` and type checks |
| **build-and-push** | Builds and pushes Docker images to ECR |
| **deploy** | Updates Knative services in EKS |

## Manual Deployment

You can also trigger the workflow manually from the Actions tab using "Run workflow".

## Troubleshooting

### ECR Login Failed
- Verify `AWS_ROLE_ARN` is correct
- Check that the IAM role has ECR permissions

### EKS Deploy Failed
- Ensure the GitHub Actions role is mapped in aws-auth ConfigMap
- Check that the role has EKS describe permissions

### Image Build Failed
- Check Dockerfile syntax
- Ensure all dependencies are available

## Security Notes

- Uses OIDC authentication (no long-lived AWS credentials)
- Images are scanned on push to ECR
- Role permissions are scoped to specific ECR repos and EKS cluster
