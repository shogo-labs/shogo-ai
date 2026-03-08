# Deployment Examples

This directory contains sanitized deployment examples for public self-hosting.

License: this directory is proprietary and covered by the Shogo Infrastructure
License in `INFRASTRUCTURE-LICENSE.md`.

The production infrastructure used for the hosted Shogo Cloud service is
managed separately and may include additional private Terraform state,
secrets-management integrations, domains, clusters, and account-specific
configuration that are not part of the public repository.

## What is in this directory

- `github-actions/repository-vars.example.md`:
  Example GitHub repository/environment variables for the public deploy
  workflow.

## What to customize

Before using the public deployment workflows or Kubernetes manifests, replace:

- Domains and hostnames
- ECR or container registry locations
- Kubernetes namespaces and cluster names
- Database credentials
- OAuth credentials
- Stripe, Composio, and AI provider secrets

## Notes

- `k8s/knative/secrets.yaml` now contains placeholder values only.
- The GitHub Actions deploy workflow reads environment-specific values from
  repository or environment variables instead of hardcoded Shogo account data.
- If you run your own infrastructure, prefer keeping your real Terraform state,
  secrets, and production overlays in a private infrastructure repository.
