# =============================================================================
# Terraform Variables - Production (us-east-1)
# Updated: March 2026 - Full parity with staging
# =============================================================================

aws_region   = "us-east-1"
environment  = "production"
project_name = "shogo"

# Bootstrap mode: set to true for first-ever apply (creates VPC, EKS, ECR, etc.)
# After EKS is created, set to false and re-apply for K8s-level resources
bootstrap_mode = false

# EKS Configuration
eks_cluster_version         = "1.33"
node_instance_types         = ["t3.xlarge"]
node_desired_size           = 1
node_min_size               = 1
node_max_size               = 15
enable_secondary_node_group = false

# Redis Configuration
redis_node_type = "cache.t3.micro"

# Knative Configuration
knative_version        = "1.20.0"
domain                 = "shogo.ai"
ssl_certificate_domain = "*.shogo.ai"

# Published Apps Domain (shogo.one)
# NOTE: CloudFront CNAME *.shogo.one is currently owned by staging.
# After staging is updated to remove it, uncomment ssl_certificate_domain_publish.
publish_domain = "shogo.one"
# ssl_certificate_domain_publish = "*.shogo.one"

# Application Secrets — provide via TF_VAR_* env vars or a local .auto.tfvars (gitignored)
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

# SigNoz K8s infrastructure monitoring
enable_signoz = true

# SigNoz Cloud endpoint (US region)
signoz_endpoint = "ingest.us.signoz.cloud:443"

# SigNoz Cloud ingestion key
signoz_ingestion_key = "lGsY7yWnJpyjvfUnWFaBCUarhjSjxSunI0Xv"

# Namespace for SigNoz collectors
signoz_namespace = "signoz"

# Feature toggles
signoz_enable_logs    = true
signoz_enable_events  = true
signoz_enable_metrics = true
