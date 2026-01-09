# =============================================================================
# Shogo AI - Production EKS Deployment
# =============================================================================
# Region: us-east-2 (Ohio)
# Architecture: Pod-per-Workspace with Knative scale-to-zero
# Updated: January 2026 - Latest package versions
# =============================================================================

terraform {
  required_version = ">= 1.5.0"  # Supports Homebrew's last open-source Terraform

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"  # Latest stable 5.x (6.0 is beta)
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

  # Uncomment for remote state (recommended for production)
  # backend "s3" {
  #   bucket         = "shogo-terraform-state"
  #   key            = "production/terraform.tfstate"
  #   region         = "us-east-2"
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
# VPC Module
# -----------------------------------------------------------------------------
module "vpc" {
  source = "../../modules/vpc"

  name               = "${var.project_name}-${var.environment}"
  cidr               = var.vpc_cidr
  availability_zones = slice(data.aws_availability_zones.available.names, 0, 3)

  tags = {
    "kubernetes.io/cluster/${var.project_name}-${var.environment}" = "shared"
  }
}

# -----------------------------------------------------------------------------
# ECR Repositories
# -----------------------------------------------------------------------------
module "ecr" {
  source = "../../modules/ecr"

  project_name = var.project_name
  environment  = var.environment

  repositories = [
    "shogo-mcp",
    "shogo-api",
    "shogo-web"
  ]
}

# -----------------------------------------------------------------------------
# EKS Cluster
# -----------------------------------------------------------------------------
module "eks" {
  source = "../../modules/eks"

  cluster_name    = "${var.project_name}-${var.environment}"
  cluster_version = var.eks_cluster_version

  vpc_id          = module.vpc.vpc_id
  private_subnets = module.vpc.private_subnet_ids

  # Node group configuration
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

  vpc_id             = module.vpc.vpc_id
  subnet_ids         = module.vpc.private_subnet_ids
  # Include both cluster and node security groups - pods use cluster SG
  security_group_ids = [
    module.eks.cluster_security_group_id,
    module.eks.node_security_group_id
  ]

  instance_class    = var.rds_instance_class
  allocated_storage = var.rds_allocated_storage

  database_name = "shogo"
  username      = "shogo"

  # Enable encryption
  storage_encrypted = true

  # Backup configuration
  backup_retention_period = 7
  backup_window           = "03:00-04:00"
  maintenance_window      = "Mon:04:00-Mon:05:00"

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

  vpc_id             = module.vpc.vpc_id
  subnet_ids         = module.vpc.private_subnet_ids
  # Include both cluster and node security groups - pods use cluster SG
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
}

# -----------------------------------------------------------------------------
# Kubernetes Resources (Namespaces, Secrets, etc.)
# -----------------------------------------------------------------------------
resource "kubernetes_namespace" "shogo_system" {
  depends_on = [module.eks]

  metadata {
    name = "shogo-system"
    labels = {
      "app.kubernetes.io/part-of" = "shogo"
    }
  }
}

resource "kubernetes_namespace" "shogo_workspaces" {
  depends_on = [module.eks]

  metadata {
    name = "shogo-workspaces"
    labels = {
      "app.kubernetes.io/part-of" = "shogo"
    }
  }
}

# Database credentials secret (shogo-system namespace)
resource "kubernetes_secret" "postgres_credentials" {
  depends_on = [kubernetes_namespace.shogo_system]

  metadata {
    name      = "postgres-credentials"
    namespace = "shogo-system"
  }

  data = {
    DATABASE_URL = "postgres://${module.rds.username}:${module.rds.password}@${module.rds.endpoint}/${module.rds.database_name}"
  }
}

# Database credentials secret (shogo-workspaces namespace)
resource "kubernetes_secret" "postgres_credentials_workspaces" {
  depends_on = [kubernetes_namespace.shogo_workspaces]

  metadata {
    name      = "postgres-credentials"
    namespace = "shogo-workspaces"
  }

  data = {
    DATABASE_URL = "postgres://${module.rds.username}:${module.rds.password}@${module.rds.endpoint}/${module.rds.database_name}"
  }
}

# API secrets
resource "kubernetes_secret" "api_secrets" {
  depends_on = [kubernetes_namespace.shogo_system]

  metadata {
    name      = "api-secrets"
    namespace = "shogo-system"
  }

  data = {
    BETTER_AUTH_SECRET = var.better_auth_secret
  }
}

# -----------------------------------------------------------------------------
# GitHub Actions OIDC (for CI/CD)
# -----------------------------------------------------------------------------
module "github_oidc" {
  source = "../../modules/github-oidc"

  project_name = var.project_name
  github_org   = var.github_org
  github_repo  = var.github_repo

  eks_cluster_arn     = module.eks.cluster_arn
  ecr_repository_arns = values(module.ecr.repository_arns)
}

