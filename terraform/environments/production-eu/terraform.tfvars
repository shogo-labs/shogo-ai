# =============================================================================
# Terraform Variables - Production EU (eu-west-1)
# Multi-region secondary cluster
# =============================================================================

aws_region         = "eu-west-1"
primary_region     = "us-east-1"
environment        = "production"
environment_suffix = "eu"
project_name       = "shogo"

# Bootstrap mode: set to true for first-ever apply (creates VPC, EKS, ECR, etc.)
# After EKS is created, set to false and re-apply for K8s-level resources
bootstrap_mode = false

# VPC CIDR must not overlap with us-east-1 (10.0.0.0/16) for VPC peering
vpc_cidr = "10.1.0.0/16"

# EKS Configuration
eks_cluster_version         = "1.33"
node_instance_types         = ["t3.xlarge"]
node_desired_size           = 1
node_min_size               = 1
node_max_size               = 15
enable_secondary_node_group = false

# Redis Configuration (Global Datastore requires m5.large minimum)
redis_node_type = "cache.m5.large"

# Knative Configuration
knative_version = "1.20.0"
domain          = "shogo.ai"

ssl_certificate_domain = "*.shogo.ai"

# Published Apps Domain
publish_domain = "shogo.one"

# Application Secrets (must match primary region)
# Provide via TF_VAR_* env vars or a local .auto.tfvars (gitignored)
# better_auth_secret
# anthropic_api_key
# google_client_id
# google_client_secret
# serper_api_key
# composio_api_key
# composio_project_id
# gh_app_client_id
# gh_app_client_secret
# gh_app_id
# gh_app_private_key
# gh_app_slug
# gh_app_webhook_secret
# stripe_secret_key
# stripe_webhook_secret

# GitHub Actions CI/CD
github_org  = "CodeGlo"
github_repo = "shogo-ai"

# SigNoz
enable_signoz = false
