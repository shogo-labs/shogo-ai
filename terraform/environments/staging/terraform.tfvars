# =============================================================================
# Terraform Variables - Staging (us-east-2)
# Updated: January 2026
# =============================================================================

aws_region   = "us-east-2"
environment  = "staging"
project_name = "shogo"

# VPC Configuration (different CIDR from production)
vpc_cidr = "10.1.0.0/16"

# EKS Configuration (smaller than production)
eks_cluster_version = "1.33"
node_instance_types = ["t3.medium"]
node_desired_size   = 1
node_min_size       = 1
node_max_size       = 5

# RDS Configuration (smaller than production)
rds_instance_class    = "db.t3.micro"
rds_allocated_storage = 20

# Redis Configuration
redis_node_type = "cache.t3.micro"

# Knative Configuration
knative_version = "1.16.0"
domain          = ""  # Set your domain here (e.g., "shogo.ai")

# Application Secrets
better_auth_secret = "shogo-staging-secret-key-must-be-at-least-32-characters-long"

# GitHub Actions CI/CD
github_org  = "CodeGlo"
github_repo = "shogo-ai"
