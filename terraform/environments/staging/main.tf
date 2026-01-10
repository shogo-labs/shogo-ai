# =============================================================================
# Shogo AI - Staging EKS Deployment
# =============================================================================
# Region: us-east-1 (Ohio)
# Architecture: Pod-per-Workspace with Knative scale-to-zero
# Updated: January 2026
# =============================================================================

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.35"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.17"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.2"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.1"
    }
  }

  # Uncomment for remote state (recommended)
  # backend "s3" {
  #   bucket         = "shogo-terraform-state"
  #   key            = "staging/terraform.tfstate"
  #   region         = "us-east-1"
  #   encrypt        = true
  #   dynamodb_table = "shogo-terraform-locks"
  # }
}

# -----------------------------------------------------------------------------
# Providers
# -----------------------------------------------------------------------------
provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Environment = var.environment
      Project     = "shogo-ai"
      ManagedBy   = "terraform"
    }
  }
}

provider "kubernetes" {
  host                   = module.eks.cluster_endpoint
  cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)

  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "aws"
    args        = ["eks", "get-token", "--cluster-name", module.eks.cluster_name]
  }
}

provider "helm" {
  kubernetes {
    host                   = module.eks.cluster_endpoint
    cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)

    exec {
      api_version = "client.authentication.k8s.io/v1beta1"
      command     = "aws"
      args        = ["eks", "get-token", "--cluster-name", module.eks.cluster_name]
    }
  }
}

# -----------------------------------------------------------------------------
# Data Sources
# -----------------------------------------------------------------------------
data "aws_availability_zones" "available" {
  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

data "aws_caller_identity" "current" {}

# -----------------------------------------------------------------------------
# ACM Certificate Lookup (for SSL termination on load balancer)
# -----------------------------------------------------------------------------
data "aws_acm_certificate" "ssl" {
  count       = var.ssl_certificate_domain != "" ? 1 : 0
  domain      = var.ssl_certificate_domain
  statuses    = ["ISSUED"]
  most_recent = true
  types       = ["AMAZON_ISSUED"]  # Prefer Amazon-issued over imported certificates
}

# -----------------------------------------------------------------------------
# VPC Module
# -----------------------------------------------------------------------------
module "vpc" {
  source = "../../modules/vpc"

  name               = "${var.project_name}-${var.environment}"
  cidr               = var.vpc_cidr
  availability_zones = slice(data.aws_availability_zones.available.names, 0, 3)

  # Use single NAT gateway to save costs and avoid EIP limits
  single_nat_gateway = true

  tags = {
    "kubernetes.io/cluster/${var.project_name}-${var.environment}" = "shared"
  }
}

# -----------------------------------------------------------------------------
# ECR Repositories (shared with production - no need to duplicate)
# -----------------------------------------------------------------------------
# Note: Staging uses the same ECR repositories as production
# Images are tagged with environment prefix (staging-*, production-*)
# If you want separate repos, uncomment below:
#
# module "ecr" {
#   source = "../../modules/ecr"
#
#   project_name = var.project_name
#   environment  = var.environment
#
#   repositories = [
#     "shogo-mcp",
#     "shogo-api",
#     "shogo-web"
#   ]
# }

# -----------------------------------------------------------------------------
# EKS Cluster
# -----------------------------------------------------------------------------
module "eks" {
  source = "../../modules/eks"

  cluster_name    = "${var.project_name}-${var.environment}"
  cluster_version = var.eks_cluster_version

  vpc_id          = module.vpc.vpc_id
  private_subnets = module.vpc.private_subnet_ids

  # Node group configuration (smaller for staging)
  node_instance_types = var.node_instance_types
  node_desired_size   = var.node_desired_size
  node_min_size       = var.node_min_size
  node_max_size       = var.node_max_size

  # Enable Karpenter for workspace autoscaling
  enable_karpenter = true

  tags = {
    Environment = var.environment
  }
}

# -----------------------------------------------------------------------------
# RDS PostgreSQL
# -----------------------------------------------------------------------------
module "rds" {
  source = "../../modules/rds"

  identifier = "${var.project_name}-${var.environment}"

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnet_ids
  # Include ALL EKS security groups: custom cluster SG, node SG, AND EKS-managed SG
  security_group_ids = [
    module.eks.cluster_security_group_id,
    module.eks.node_security_group_id,
    module.eks.eks_managed_security_group_id
  ]

  instance_class          = var.rds_instance_class
  allocated_storage       = var.rds_allocated_storage
  backup_retention_period = var.rds_backup_retention_period

  database_name = "shogo"
  username      = "shogo"

  # Enable encryption
  storage_encrypted = true

  # Backup configuration (Free Tier accounts need 0 retention)
  backup_window      = "03:00-04:00"
  maintenance_window = "Mon:04:00-Mon:05:00"

  tags = {
    Environment = var.environment
  }
}

# -----------------------------------------------------------------------------
# ElastiCache Redis
# -----------------------------------------------------------------------------
module "elasticache" {
  source = "../../modules/elasticache"

  cluster_id = "${var.project_name}-${var.environment}"

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnet_ids
  security_group_ids = [
    module.eks.cluster_security_group_id,
    module.eks.node_security_group_id
  ]

  node_type       = var.redis_node_type
  num_cache_nodes = 1

  tags = {
    Environment = var.environment
  }
}

# -----------------------------------------------------------------------------
# Knative Serving
# -----------------------------------------------------------------------------
module "knative" {
  source = "../../modules/knative"

  depends_on = [module.eks]

  knative_version = var.knative_version
  domain          = var.domain

  # Scale-to-zero configuration
  scale_to_zero_grace_period = "60s"

  # SSL certificate for HTTPS termination on load balancer
  ssl_certificate_arn = var.ssl_certificate_domain != "" ? data.aws_acm_certificate.ssl[0].arn : ""
}

# -----------------------------------------------------------------------------
# Kubernetes Resources (Namespaces, Secrets, etc.)
# Note: Staging uses different namespace names
# -----------------------------------------------------------------------------
resource "kubernetes_namespace" "shogo_system" {
  depends_on = [module.eks]

  metadata {
    name = "shogo-staging-system"
    labels = {
      "app.kubernetes.io/part-of" = "shogo"
      "environment"               = "staging"
    }
  }
}

resource "kubernetes_namespace" "shogo_workspaces" {
  depends_on = [module.eks]

  metadata {
    name = "shogo-staging-workspaces"
    labels = {
      "app.kubernetes.io/part-of" = "shogo"
      "environment"               = "staging"
    }
  }
}

# Database credentials secret (shogo-staging-system namespace)
resource "kubernetes_secret" "postgres_credentials" {
  depends_on = [kubernetes_namespace.shogo_system]

  metadata {
    name      = "postgres-credentials"
    namespace = "shogo-staging-system"
  }

  data = {
    DATABASE_URL = "postgres://${module.rds.username}:${module.rds.password}@${module.rds.endpoint}/${module.rds.database_name}"
  }
}

# Database credentials secret (shogo-staging-workspaces namespace)
resource "kubernetes_secret" "postgres_credentials_workspaces" {
  depends_on = [kubernetes_namespace.shogo_workspaces]

  metadata {
    name      = "postgres-credentials"
    namespace = "shogo-staging-workspaces"
  }

  data = {
    DATABASE_URL = "postgres://${module.rds.username}:${module.rds.password}@${module.rds.endpoint}/${module.rds.database_name}"
  }
}

# Redis credentials secret (shogo-staging-system namespace)
resource "kubernetes_secret" "redis_credentials" {
  depends_on = [kubernetes_namespace.shogo_system]

  metadata {
    name      = "redis-credentials"
    namespace = "shogo-staging-system"
  }

  data = {
    REDIS_URL = "redis://${module.elasticache.endpoint}:6379"
  }
}

# API secrets
resource "kubernetes_secret" "api_secrets" {
  depends_on = [kubernetes_namespace.shogo_system]

  metadata {
    name      = "api-secrets"
    namespace = "shogo-staging-system"
  }

  data = {
    BETTER_AUTH_SECRET = var.better_auth_secret
  }
}

# -----------------------------------------------------------------------------
# GitHub Actions OIDC (for CI/CD)
# -----------------------------------------------------------------------------
# NOTE: Staging shares the GitHub OIDC role with production
# The role "shogo-github-actions" is created by the production environment
# and has permissions for both clusters. No need to create a separate role.
#
# If you need a separate role, uncomment below and change the role name:
# module "github_oidc" {
#   source = "../../modules/github-oidc"
#
#   project_name = "${var.project_name}-${var.environment}"  # Makes role name unique
#   github_org   = var.github_org
#   github_repo  = var.github_repo
#
#   eks_cluster_arn     = module.eks.cluster_arn
#   ecr_repository_arns = [
#     "arn:aws:ecr:${var.aws_region}:${data.aws_caller_identity.current.account_id}:repository/shogo/shogo-mcp",
#     "arn:aws:ecr:${var.aws_region}:${data.aws_caller_identity.current.account_id}:repository/shogo/shogo-api",
#     "arn:aws:ecr:${var.aws_region}:${data.aws_caller_identity.current.account_id}:repository/shogo/shogo-web"
#   ]
# }
