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

# Application Secrets
better_auth_secret = "F8sqaFlb/uF++IX7EqIK7jDGhGm0VMVJCp+cvzXL0WyznLac1+fPEUOn3W+xTyPa"

# GitHub Actions CI/CD
github_org  = "CodeGlo"
github_repo = "shogo-ai"

# SigNoz (disabled for now - enable when needed)
enable_signoz = false
