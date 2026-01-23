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
node_instance_types         = ["t3.medium"]  # 17 pod limit per node, 4GB RAM
node_desired_size           = 2              # Need 2 nodes for system + app pods
node_min_size               = 2              # Keep 2 minimum to avoid scheduling issues
node_max_size               = 5
enable_secondary_node_group = true           # Secondary node group for additional capacity

# RDS Configuration (smaller than production)
rds_instance_class         = "db.t3.micro"
rds_allocated_storage      = 20
rds_backup_retention_period = 0  # Free Tier limitation

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

# Application Secrets
better_auth_secret = "shogo-staging-secret-key-must-be-at-least-32-characters-long"

# GitHub Actions CI/CD
github_org  = "CodeGlo"
github_repo = "shogo-ai"
