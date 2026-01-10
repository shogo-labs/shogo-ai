# =============================================================================
# Terraform Variables - Production (us-east-1)
# Updated: January 2026 - Latest package versions
# =============================================================================

aws_region   = "us-east-1"
environment  = "production"
project_name = "shogo"

# EKS Configuration (Kubernetes 1.33 - latest EKS supported)
eks_cluster_version = "1.33"
node_instance_types = ["t3.medium", "t3.large"]
node_desired_size   = 2
node_min_size       = 1
node_max_size       = 10

# RDS Configuration (PostgreSQL 16 - latest stable)
rds_instance_class    = "db.t3.small"
rds_allocated_storage = 20

# Redis Configuration
redis_node_type = "cache.t3.micro"

# Knative Configuration (1.16.0 - latest stable)
knative_version = "1.16.0"
domain          = ""  # Set your domain here (e.g., "shogo.ai")

# Application Secrets
better_auth_secret = "shogo-production-secret-key-must-be-at-least-32-characters-long"

# GitHub Actions CI/CD
github_org  = "CodeGlo"
github_repo = "shogo-ai"
