# =============================================================================
# Terraform Variables - Staging (us-east-1)
# Updated: January 2026
# =============================================================================

aws_region   = "us-east-1"
environment  = "staging"
project_name = "shogo"

# VPC Configuration (different CIDR from production)
vpc_cidr = "10.1.0.0/16"

# EKS Configuration (smaller than production)
eks_cluster_version         = "1.33"
node_instance_types         = ["t3.xlarge"]  # 58 pod limit per node, 16GB RAM
node_desired_size           = 2              # Need 2 nodes for system + app pods
node_min_size               = 2              # Keep 2 minimum to avoid scheduling issues
node_max_size               = 6
enable_secondary_node_group = false          # Disabled - was duplicate of main nodegroup, wasting vCPU quota

# CloudNativePG Configuration
# S3 credentials for backups (leave empty to use EKS node IAM role)
# For bare metal with MinIO, set these to your MinIO credentials
# cnpg_s3_access_key_id     = ""
# cnpg_s3_secret_access_key = ""

# Redis Configuration
redis_node_type = "cache.t3.micro"

# Knative Configuration
knative_version        = "1.20.0"
domain                 = "shogo.ai"
ssl_certificate_domain = "*.shogo.ai"  # ACM certificate for platform (Amazon-issued)

# Published Apps Domain (shogo.one)
# User-published apps are served at *.shogo.one
publish_domain                 = "shogo.one"
ssl_certificate_domain_publish = "*.shogo.one"  # ACM certificate for published apps

# Preview Subdomains (*.staging.shogo.ai)
# Project preview iframes served at preview--{id}.staging.shogo.ai
ssl_certificate_domain_preview = "*.staging.shogo.ai"  # ACM certificate for preview subdomains

# Application Secrets
better_auth_secret = "shogo-staging-secret-key-must-be-at-least-32-characters-long"
anthropic_api_key  = "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"

# GitHub Actions CI/CD
github_org  = "CodeGlo"
github_repo = "shogo-ai"
# =============================================================================
# SigNoz Configuration for Staging
# =============================================================================
# This file contains your SigNoz Cloud credentials
# Merge these into your terraform.tfvars file
# =============================================================================

# Enable SigNoz K8s infrastructure monitoring
enable_signoz = true

# SigNoz Cloud endpoint (US region)
signoz_endpoint = "ingest.us.signoz.cloud:443"

# SigNoz Cloud ingestion key
signoz_ingestion_key = "xLFY6djeWtEqZt1eGrYTwKkKeR5kCua-VB1w"

# Namespace for SigNoz collectors
signoz_namespace = "signoz"

# Feature toggles (logs disabled by default to reduce resource usage)
signoz_enable_logs    = false  # Set to true if you need container logs
signoz_enable_events  = true   # K8s events (lightweight)
signoz_enable_metrics = true   # Node/pod metrics (essential)
