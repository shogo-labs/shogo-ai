# =============================================================================
# Shogo AI - Staging EKS Deployment
# =============================================================================
# Region: us-east-1 (N. Virginia)
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

  # Remote state backend (recommended)
  backend "s3" {
    bucket         = "shogo-terraform-state"
    key            = "staging/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    # dynamodb_table = "shogo-terraform-locks"  # Optional: enables state locking
  }
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

# -----------------------------------------------------------------------------
# EKS Cluster Data Sources (for provider configuration)
# These use the computed cluster name to avoid circular dependency with module.eks
# In bootstrap mode, these are skipped and providers use dummy values
# -----------------------------------------------------------------------------
locals {
  eks_cluster_name = "${var.project_name}-${var.environment}"
}

data "aws_eks_cluster" "cluster" {
  count = var.bootstrap_mode ? 0 : 1
  name  = local.eks_cluster_name
}

data "aws_eks_cluster_auth" "cluster" {
  count = var.bootstrap_mode ? 0 : 1
  name  = local.eks_cluster_name
}

# Note: In bootstrap mode, these providers use dummy values since EKS doesn't exist yet.
# After initial EKS creation, set bootstrap_mode = false and re-apply.
#
# Uses exec-based auth for stable provider initialization
# (avoids chicken-and-egg issue with data source evaluation timing)
provider "kubernetes" {
  host                   = var.bootstrap_mode ? "https://localhost" : data.aws_eks_cluster.cluster[0].endpoint
  cluster_ca_certificate = var.bootstrap_mode ? "" : base64decode(data.aws_eks_cluster.cluster[0].certificate_authority[0].data)

  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "aws"
    args        = ["eks", "get-token", "--cluster-name", local.eks_cluster_name, "--region", var.aws_region]
  }
}

provider "helm" {
  kubernetes {
    host                   = var.bootstrap_mode ? "https://localhost" : data.aws_eks_cluster.cluster[0].endpoint
    cluster_ca_certificate = var.bootstrap_mode ? "" : base64decode(data.aws_eks_cluster.cluster[0].certificate_authority[0].data)

    exec {
      api_version = "client.authentication.k8s.io/v1beta1"
      command     = "aws"
      args        = ["eks", "get-token", "--cluster-name", local.eks_cluster_name, "--region", var.aws_region]
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
# Primary certificate for platform (*.shogo.ai)
data "aws_acm_certificate" "ssl" {
  count       = var.ssl_certificate_domain != "" ? 1 : 0
  domain      = var.ssl_certificate_domain
  statuses    = ["ISSUED"]
  most_recent = true
  types       = ["AMAZON_ISSUED"] # Prefer Amazon-issued over imported certificates
}

# Secondary certificate for published apps (*.shogo.one)
data "aws_acm_certificate" "ssl_publish" {
  count       = var.ssl_certificate_domain_publish != "" ? 1 : 0
  domain      = var.ssl_certificate_domain_publish
  statuses    = ["ISSUED"]
  most_recent = true
  types       = ["AMAZON_ISSUED"]
}

# Tertiary certificate for preview subdomains (*.staging.shogo.ai)
# Required for subdomain-based preview URLs: preview--{projectId}.staging.shogo.ai
data "aws_acm_certificate" "ssl_preview" {
  count       = var.ssl_certificate_domain_preview != "" ? 1 : 0
  domain      = var.ssl_certificate_domain_preview
  statuses    = ["ISSUED"]
  most_recent = true
  types       = ["AMAZON_ISSUED"]
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
  node_disk_size      = 50  # GB - increased from 20GB default to handle large container images

  # Enable secondary node group for additional capacity (matching deployed config)
  enable_secondary_node_group = var.enable_secondary_node_group

  # Enable Karpenter for workspace autoscaling
  enable_karpenter = true

  # Grant cluster-admin access to GitHub Actions role (shared with production)
  admin_role_arns = [
    "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${var.project_name}-github-actions"
  ]

  tags = {
    Environment = var.environment
  }
}

# -----------------------------------------------------------------------------
# RDS PostgreSQL (LEGACY - kept during migration to CloudNativePG)
# -----------------------------------------------------------------------------
# This RDS instance is kept alive during the migration period.
# Once data is migrated to CloudNativePG and verified, this module
# and its resources can be removed.
# -----------------------------------------------------------------------------
module "rds" {
  source = "../../modules/rds"

  identifier = "${var.project_name}-${var.environment}"

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnet_ids
  security_group_ids = [
    module.eks.cluster_security_group_id,
    module.eks.node_security_group_id,
    module.eks.eks_managed_security_group_id
  ]

  instance_class          = "db.t3.micro"
  allocated_storage       = 20
  backup_retention_period = 0

  database_name = "shogo"
  username      = "shogo"

  storage_encrypted  = true
  backup_window      = "03:00-04:00"
  maintenance_window = "Mon:04:00-Mon:05:00"

  tags = {
    Environment = var.environment
  }
}

# -----------------------------------------------------------------------------
# CloudNativePG Operator (new - replaces RDS)
# -----------------------------------------------------------------------------
# Installs the CloudNativePG operator which manages PostgreSQL clusters
# as Kubernetes-native resources. Works identically on EKS, k3s, and bare metal.
# PostgreSQL clusters are defined in k8s/cnpg/staging/ and applied below.
# -----------------------------------------------------------------------------
module "cnpg" {
  count  = var.bootstrap_mode ? 0 : 1
  source = "../../modules/cnpg"

  depends_on = [module.eks]

  chart_version = "0.23.0"
  namespace     = "cnpg-system"

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
  # Include ALL EKS security groups: custom cluster SG, node SG, AND EKS-managed SG
  security_group_ids = [
    module.eks.cluster_security_group_id,
    module.eks.node_security_group_id,
    module.eks.eks_managed_security_group_id
  ]

  node_type       = var.redis_node_type
  num_cache_nodes = 1

  tags = {
    Environment = var.environment
  }
}

# NOTE: EFS module removed. PostgreSQL sidecars replaced by shared CloudNativePG cluster.
# EFS is no longer needed for per-project database storage.

# -----------------------------------------------------------------------------
# VPC Endpoints (for private subnet access to AWS services)
# Required for EKS nodes in private subnets to pull images from ECR
# -----------------------------------------------------------------------------

# Security group for VPC endpoints (interface type)
resource "aws_security_group" "vpc_endpoints" {
  name        = "${var.project_name}-${var.environment}-vpc-endpoints-sg"
  description = "Security group for VPC endpoints"
  vpc_id      = module.vpc.vpc_id

  # Allow HTTPS from EKS nodes (required for ECR API/DKR endpoints)
  ingress {
    description     = "HTTPS from EKS nodes"
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    security_groups = [module.eks.node_security_group_id]
  }

  # Also allow from EKS cluster and EKS-managed security groups
  ingress {
    description = "HTTPS from EKS cluster"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    security_groups = [
      module.eks.cluster_security_group_id,
      module.eks.eks_managed_security_group_id
    ]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name        = "${var.project_name}-${var.environment}-vpc-endpoints-sg"
    Environment = var.environment
  }
}

# ECR API endpoint (for docker login, image manifest operations)
resource "aws_vpc_endpoint" "ecr_api" {
  vpc_id              = module.vpc.vpc_id
  service_name        = "com.amazonaws.${var.aws_region}.ecr.api"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = module.vpc.private_subnet_ids
  security_group_ids  = [aws_security_group.vpc_endpoints.id]
  private_dns_enabled = true

  tags = {
    Name        = "${var.project_name}-${var.environment}-ecr-api"
    Environment = var.environment
  }
}

# ECR DKR endpoint (for docker pull/push operations)
resource "aws_vpc_endpoint" "ecr_dkr" {
  vpc_id              = module.vpc.vpc_id
  service_name        = "com.amazonaws.${var.aws_region}.ecr.dkr"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = module.vpc.private_subnet_ids
  security_group_ids  = [aws_security_group.vpc_endpoints.id]
  private_dns_enabled = true

  tags = {
    Name        = "${var.project_name}-${var.environment}-ecr-dkr"
    Environment = var.environment
  }
}

# S3 endpoint (gateway type - required for ECR layer downloads)
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = module.vpc.vpc_id
  service_name      = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = module.vpc.private_route_table_ids

  tags = {
    Name        = "${var.project_name}-${var.environment}-s3"
    Environment = var.environment
  }
}

# -----------------------------------------------------------------------------
# AWS Load Balancer Controller (for ALB with SNI multi-certificate support)
# Note: Skipped in bootstrap_mode since it requires kubernetes/helm providers
# -----------------------------------------------------------------------------
module "aws_lb_controller" {
  count  = var.bootstrap_mode ? 0 : 1
  source = "../../modules/aws-load-balancer-controller"

  depends_on = [module.eks]

  cluster_name      = module.eks.cluster_name
  oidc_provider_arn = module.eks.oidc_provider_arn
  oidc_provider_url = module.eks.oidc_provider_url
  vpc_id            = module.vpc.vpc_id
  region            = var.aws_region

  tags = {
    Environment = var.environment
  }
}

# -----------------------------------------------------------------------------
# Knative Serving
# Note: Skipped in bootstrap_mode since it requires kubernetes/helm providers
# -----------------------------------------------------------------------------
module "knative" {
  count  = var.bootstrap_mode ? 0 : 1
  source = "../../modules/knative"

  depends_on = [module.eks, module.aws_lb_controller]

  knative_version = var.knative_version
  domain          = var.domain
  publish_domain  = var.publish_domain

  # Scale-to-zero configuration
  scale_to_zero_grace_period = "60s"

  # Enable PVC support for pod-per-project architecture
  # Required for project pods to mount persistent volumes for code storage
  enable_pvc_support = true

  # SSL certificates for HTTPS termination on ALB
  # Primary: *.shogo.ai for platform
  ssl_certificate_arn = var.ssl_certificate_domain != "" ? data.aws_acm_certificate.ssl[0].arn : ""
  # Secondary: *.shogo.one for published apps (SNI routing)
  ssl_certificate_arn_publish = var.ssl_certificate_domain_publish != "" ? data.aws_acm_certificate.ssl_publish[0].arn : ""
  # Tertiary: *.staging.shogo.ai for preview subdomains (SNI routing)
  ssl_certificate_arn_preview = var.ssl_certificate_domain_preview != "" ? data.aws_acm_certificate.ssl_preview[0].arn : ""

  # ECR registry - skip tag resolution (avoids auth issues with Knative controller)
  ecr_registry = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.aws_region}.amazonaws.com"
}

# -----------------------------------------------------------------------------
# SigNoz K8s Infrastructure Monitoring
# Note: Skipped in bootstrap_mode since it requires kubernetes/helm providers
# -----------------------------------------------------------------------------
module "signoz" {
  count  = !var.bootstrap_mode && var.enable_signoz && var.signoz_endpoint != "" ? 1 : 0
  source = "../../modules/signoz"

  depends_on = [module.eks]

  cluster_name         = module.eks.cluster_name
  signoz_endpoint      = var.signoz_endpoint
  signoz_ingestion_key = var.signoz_ingestion_key
  environment          = var.environment

  # Namespace configuration
  namespace        = var.signoz_namespace
  create_namespace = true

  # Feature flags
  enable_logs    = var.signoz_enable_logs
  enable_events  = var.signoz_enable_events
  enable_metrics = var.signoz_enable_metrics

  # Resource limits (staging-appropriate)
  resource_limits = {
    cpu    = "500m"
    memory = "512Mi"
  }

  resource_requests = {
    cpu    = "100m"
    memory = "128Mi"
  }

  tags = {
    Environment = var.environment
    ManagedBy   = "terraform"
    Project     = var.project_name
  }
}

# -----------------------------------------------------------------------------
# CloudNativePG PostgreSQL Clusters
# Deploy platform-pg and projects-pg clusters via kubectl
# -----------------------------------------------------------------------------
resource "null_resource" "cnpg_clusters" {
  count = var.bootstrap_mode ? 0 : 1

  depends_on = [
    module.cnpg[0],
    module.eks,
  ]

  triggers = {
    # Re-apply when cluster manifests change
    platform_hash = filemd5("${path.module}/../../../k8s/cnpg/staging/platform-cluster.yaml")
    projects_hash = filemd5("${path.module}/../../../k8s/cnpg/staging/projects-cluster.yaml")
  }

  provisioner "local-exec" {
    command = <<-EOT
      echo "Waiting for CloudNativePG operator to be ready..."
      kubectl wait --for=condition=Available deployment -l app.kubernetes.io/name=cloudnative-pg -n cnpg-system --timeout=120s || true

      # Ensure the target namespace exists
      kubectl get namespace shogo-staging-system || kubectl create namespace shogo-staging-system

      echo "Deploying CloudNativePG clusters..."
      kubectl apply -f ${path.module}/../../../k8s/cnpg/staging/platform-cluster.yaml
      kubectl apply -f ${path.module}/../../../k8s/cnpg/staging/projects-cluster.yaml

      echo "Waiting for clusters to be ready..."
      kubectl wait --for=condition=Ready cluster/platform-pg -n shogo-staging-system --timeout=300s || true
      kubectl wait --for=condition=Ready cluster/projects-pg -n shogo-staging-system --timeout=300s || true

      echo "CloudNativePG clusters deployed successfully"
    EOT
  }
}

# S3 bucket for CloudNativePG backups (Barman WAL archiving)
resource "aws_s3_bucket" "pg_backups" {
  bucket = "shogo-pg-backups-${var.environment}"

  tags = {
    Name        = "shogo-pg-backups-${var.environment}"
    Environment = var.environment
    Purpose     = "cloudnativepg-backups"
  }
}

resource "aws_s3_bucket_versioning" "pg_backups" {
  bucket = aws_s3_bucket.pg_backups.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "pg_backups" {
  bucket = aws_s3_bucket.pg_backups.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "pg_backups" {
  bucket = aws_s3_bucket.pg_backups.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "pg_backups" {
  bucket = aws_s3_bucket.pg_backups.id

  rule {
    id     = "cleanup-old-backups"
    status = "Enabled"

    filter {}

    # Move old backups to cheaper storage after 30 days
    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }

    # Delete backups older than 90 days
    expiration {
      days = 90
    }
  }
}

# IAM Policy for CloudNativePG to access S3 backups
resource "aws_iam_policy" "cnpg_s3_backup" {
  name        = "shogo-cnpg-s3-backup-${var.environment}"
  description = "Allow CloudNativePG pods to read/write S3 backups"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket",
          "s3:GetBucketLocation"
        ]
        Resource = [
          aws_s3_bucket.pg_backups.arn,
          "${aws_s3_bucket.pg_backups.arn}/*"
        ]
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "node_cnpg_s3_access" {
  policy_arn = aws_iam_policy.cnpg_s3_backup.arn
  role       = module.eks.node_role_name
}

# -----------------------------------------------------------------------------
# Kubernetes Resources (Namespaces, Secrets, etc.)
# Note: Staging uses different namespace names
# Note: These are skipped in bootstrap_mode since kubernetes provider isn't configured
# -----------------------------------------------------------------------------
resource "kubernetes_namespace" "shogo_system" {
  count      = var.bootstrap_mode ? 0 : 1
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
  count      = var.bootstrap_mode ? 0 : 1
  depends_on = [module.eks]

  metadata {
    name = "shogo-staging-workspaces"
    labels = {
      "app.kubernetes.io/part-of" = "shogo"
      "environment"               = "staging"
    }
  }
}

# NOTE: Platform database credentials are auto-generated by CloudNativePG
# The operator creates secrets: platform-pg-superuser, platform-pg-app
# with keys: username, password, host, port, dbname, uri
#
# We create a bridge secret that references the CNPG-generated URI
# so existing K8s manifests can use the same postgres-credentials secret name.
# After CNPG clusters are created (via null_resource below), the secrets exist.

resource "null_resource" "postgres_credentials" {
  count = var.bootstrap_mode ? 0 : 1

  depends_on = [
    kubernetes_namespace.shogo_system,
    kubernetes_namespace.shogo_workspaces,
    null_resource.cnpg_clusters,
  ]

  triggers = {
    timestamp = timestamp()
  }

  provisioner "local-exec" {
    command = <<-EOT
      # Wait for CNPG to create the platform-pg-app secret
      echo "Waiting for CloudNativePG platform-pg-app secret..."
      for i in $(seq 1 60); do
        if kubectl get secret platform-pg-app -n shogo-staging-system > /dev/null 2>&1; then
          echo "Secret platform-pg-app found"
          break
        fi
        echo "Waiting... (attempt $i)"
        sleep 5
      done

      # Extract the connection URI from the CNPG-generated secret
      PLATFORM_URI=$(kubectl get secret platform-pg-app -n shogo-staging-system -o jsonpath='{.data.uri}' | base64 -d)
      
      if [ -z "$PLATFORM_URI" ]; then
        echo "ERROR: Could not extract platform-pg URI"
        exit 1
      fi

      echo "Platform DB URI extracted successfully"

      # Create postgres-credentials secret in system namespace
      kubectl create secret generic postgres-credentials \
        --namespace shogo-staging-system \
        --from-literal=DATABASE_URL="$PLATFORM_URI" \
        --dry-run=client -o yaml | kubectl apply -f -

      # Create postgres-credentials secret in workspaces namespace
      kubectl create secret generic postgres-credentials \
        --namespace shogo-staging-workspaces \
        --from-literal=DATABASE_URL="$PLATFORM_URI" \
        --dry-run=client -o yaml | kubectl apply -f -

      # Wait for projects-pg-superuser secret
      echo "Waiting for CloudNativePG projects-pg-superuser secret..."
      for i in $(seq 1 60); do
        if kubectl get secret projects-pg-superuser -n shogo-staging-system > /dev/null 2>&1; then
          echo "Secret projects-pg-superuser found"
          break
        fi
        echo "Waiting... (attempt $i)"
        sleep 5
      done

      # Extract projects cluster admin URI
      PROJECTS_ADMIN_URI=$(kubectl get secret projects-pg-superuser -n shogo-staging-system -o jsonpath='{.data.uri}' | base64 -d)
      
      # Create projects-db-admin secret for the API to use for database provisioning
      if [ -n "$PROJECTS_ADMIN_URI" ]; then
        kubectl create secret generic projects-db-admin \
          --namespace shogo-staging-system \
          --from-literal=PROJECTS_DB_ADMIN_URL="$PROJECTS_ADMIN_URI" \
          --from-literal=PROJECTS_DB_HOST="projects-pg-rw.shogo-staging-system.svc.cluster.local" \
          --from-literal=PROJECTS_DB_PORT="5432" \
          --dry-run=client -o yaml | kubectl apply -f -
        echo "Projects DB admin secret created"
      fi

      echo "All database secrets created successfully"
    EOT
  }
}

# S3 credentials for CloudNativePG backups (Barman)
resource "kubernetes_secret" "cnpg_s3_credentials" {
  count      = var.bootstrap_mode ? 0 : 1
  depends_on = [kubernetes_namespace.shogo_system]

  metadata {
    name      = "cnpg-s3-credentials"
    namespace = "shogo-staging-system"
  }

  data = {
    # These are populated by the EKS node role (IRSA) or can be set explicitly
    # For bare metal with MinIO, set these to MinIO credentials
    ACCESS_KEY_ID     = var.cnpg_s3_access_key_id
    SECRET_ACCESS_KEY = var.cnpg_s3_secret_access_key
    REGION            = var.aws_region
  }
}

# Redis credentials secret (shogo-staging-system namespace)
resource "kubernetes_secret" "redis_credentials" {
  count      = var.bootstrap_mode ? 0 : 1
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
  count      = var.bootstrap_mode ? 0 : 1
  depends_on = [kubernetes_namespace.shogo_system]

  metadata {
    name      = "api-secrets"
    namespace = "shogo-staging-system"
  }

  data = merge(
    {
      BETTER_AUTH_SECRET = var.better_auth_secret
    },
    var.anthropic_api_key != "" ? {
      ANTHROPIC_API_KEY = var.anthropic_api_key
    } : {}
  )
}

# SigNoz credentials for application-level OTEL tracing
resource "kubernetes_secret" "signoz_credentials" {
  count      = var.bootstrap_mode || var.signoz_ingestion_key == "" ? 0 : 1
  depends_on = [kubernetes_namespace.shogo_system]

  metadata {
    name      = "signoz-credentials"
    namespace = "shogo-staging-system"
  }

  data = {
    SIGNOZ_INGESTION_KEY = var.signoz_ingestion_key
  }
}

# SigNoz credentials for project/agent pods (shogo-staging-workspaces namespace)
resource "kubernetes_secret" "signoz_credentials_workspaces" {
  count      = var.bootstrap_mode || var.signoz_ingestion_key == "" ? 0 : 1
  depends_on = [kubernetes_namespace.shogo_workspaces]

  metadata {
    name      = "signoz-credentials"
    namespace = "shogo-staging-workspaces"
  }

  data = {
    SIGNOZ_INGESTION_KEY = var.signoz_ingestion_key
  }
}

# Anthropic credentials for project pods (shogo-staging-workspaces namespace)
resource "kubernetes_secret" "anthropic_credentials_workspaces" {
  count      = var.bootstrap_mode || var.anthropic_api_key == "" ? 0 : 1
  depends_on = [kubernetes_namespace.shogo_workspaces]

  metadata {
    name      = "anthropic-credentials"
    namespace = "shogo-staging-workspaces"
  }

  data = {
    api-key = var.anthropic_api_key
  }
}

# Preview secrets for project pods (JWT validation)
resource "kubernetes_secret" "preview_secrets_workspaces" {
  depends_on = [kubernetes_namespace.shogo_workspaces]

  metadata {
    name      = "preview-secrets"
    namespace = "shogo-staging-workspaces"
  }

  data = {
    BETTER_AUTH_SECRET = var.better_auth_secret
  }
}

# -----------------------------------------------------------------------------
# S3 Bucket for Workspace Files (emptyDir persistence)
# -----------------------------------------------------------------------------
# This bucket stores project files when using emptyDir volumes.
# Files are synced to S3 for persistence across pod restarts.

resource "aws_s3_bucket" "workspaces" {
  bucket = "shogo-workspaces-${var.environment}"

  tags = {
    Name        = "shogo-workspaces-${var.environment}"
    Environment = var.environment
    Purpose     = "workspace-file-storage"
  }
}

resource "aws_s3_bucket_versioning" "workspaces" {
  bucket = aws_s3_bucket.workspaces.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "workspaces" {
  bucket = aws_s3_bucket.workspaces.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "workspaces" {
  bucket = aws_s3_bucket.workspaces.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Lifecycle rule: Delete old versions after 30 days
resource "aws_s3_bucket_lifecycle_configuration" "workspaces" {
  bucket = aws_s3_bucket.workspaces.id

  rule {
    id     = "cleanup-old-versions"
    status = "Enabled"

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}

# IAM Policy for project-runtime pods to access S3
resource "aws_iam_policy" "project_runtime_s3_access" {
  name        = "shogo-project-runtime-s3-${var.environment}"
  description = "Allow project-runtime pods to access S3 workspaces bucket"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.workspaces.arn,
          "${aws_s3_bucket.workspaces.arn}/*"
        ]
      }
    ]
  })
}

# Attach S3 policy to EKS node role (so project-runtime pods can access S3)
resource "aws_iam_role_policy_attachment" "node_s3_access" {
  policy_arn = aws_iam_policy.project_runtime_s3_access.arn
  role       = module.eks.node_role_name
}

# S3 credentials secret for project pods (shogo-staging-workspaces namespace)
resource "kubernetes_secret" "s3_credentials_workspaces" {
  depends_on = [kubernetes_namespace.shogo_workspaces]

  metadata {
    name      = "s3-credentials"
    namespace = "shogo-staging-workspaces"
  }

  data = {
    "workspaces-bucket" = aws_s3_bucket.workspaces.id
    "region"            = var.aws_region
  }
}

# -----------------------------------------------------------------------------
# Storage Class for EBS CSI Driver (for project PVCs)
# -----------------------------------------------------------------------------
resource "kubernetes_storage_class" "ebs_sc" {
  count      = var.bootstrap_mode ? 0 : 1
  depends_on = [module.eks]

  metadata {
    name = "ebs-sc"
    annotations = {
      "storageclass.kubernetes.io/is-default-class" = "false"
    }
  }

  storage_provisioner    = "ebs.csi.aws.com"
  reclaim_policy         = "Delete"
  allow_volume_expansion = true
  volume_binding_mode    = "WaitForFirstConsumer"

  parameters = {
    type      = "gp3"
    encrypted = "true"
  }
}

# -----------------------------------------------------------------------------
# Knative Services (Application Deployment)
# -----------------------------------------------------------------------------
# Deploy application services via kubectl (avoids kubernetes_manifest CRD issues)

locals {
  ecr_registry = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.aws_region}.amazonaws.com"
  image_tag    = "${var.environment}-latest"
}

# Deploy all Knative services and domain mappings
resource "null_resource" "knative_services" {
  count = var.bootstrap_mode ? 0 : 1

  depends_on = [
    module.knative[0],
    kubernetes_namespace.shogo_system[0],
    kubernetes_namespace.shogo_workspaces[0],
    null_resource.postgres_credentials[0],
    null_resource.cnpg_clusters[0],
    kubernetes_secret.redis_credentials[0],
    kubernetes_secret.api_secrets[0]
  ]

  triggers = {
    # Trigger redeployment when image tag changes
    image_tag    = local.image_tag
    ecr_registry = local.ecr_registry
    # Force redeploy: bumped API memory from 512Mi to 2Gi
    api_memory   = "2Gi"
    # Add timestamp trigger for manual refresh (uncomment to force redeploy)
    # timestamp = timestamp()
  }

  provisioner "local-exec" {
    command = <<-EOT
      # Wait for Knative to be ready
      kubectl wait --for=condition=Available deployment/controller -n knative-serving --timeout=120s || true
      
      # Deploy Studio (Web) Service
      cat <<EOF | kubectl apply -f -
      apiVersion: serving.knative.dev/v1
      kind: Service
      metadata:
        name: studio
        namespace: shogo-staging-system
        labels:
          app.kubernetes.io/part-of: shogo
          environment: staging
      spec:
        template:
          metadata:
            annotations:
              autoscaling.knative.dev/min-scale: "1"
              autoscaling.knative.dev/max-scale: "5"
          spec:
            containers:
              - name: web
                image: ${local.ecr_registry}/shogo/shogo-web:${local.image_tag}
                ports:
                  - containerPort: 80
                env:
                  - name: API_UPSTREAM
                    value: "http://api.shogo-staging-system.svc.cluster.local"
                  - name: API_HOST
                    value: "api.shogo-staging-system.svc.cluster.local"
                  - name: MCP_UPSTREAM
                    value: "http://mcp-workspace-1.shogo-staging-workspaces.svc.cluster.local"
                  - name: MCP_HOST
                    value: "mcp-workspace-1.shogo-staging-workspaces.svc.cluster.local"
                  - name: DNS_RESOLVER
                    value: "kube-dns.kube-system.svc.cluster.local"
                resources:
                  requests:
                    memory: "128Mi"
                    cpu: "50m"
                  limits:
                    memory: "256Mi"
                    cpu: "200m"
      EOF

      # Deploy API Service
      cat <<EOF | kubectl apply -f -
      apiVersion: serving.knative.dev/v1
      kind: Service
      metadata:
        name: api
        namespace: shogo-staging-system
        labels:
          app.kubernetes.io/part-of: shogo
          environment: staging
      spec:
        template:
          metadata:
            annotations:
              autoscaling.knative.dev/min-scale: "1"
              autoscaling.knative.dev/max-scale: "5"
          spec:
            containers:
              - name: api
                image: ${local.ecr_registry}/shogo/shogo-api:${local.image_tag}
                ports:
                  - containerPort: 8002
                env:
                  - name: API_PORT
                    value: "8002"
                  - name: NODE_ENV
                    value: "staging"
                  - name: NODE_TLS_REJECT_UNAUTHORIZED
                    value: "0"
                  - name: MCP_URL
                    value: "http://mcp-workspace-1.shogo-staging-workspaces.svc.cluster.local"
                  - name: BETTER_AUTH_URL
                    value: "https://studio-staging.shogo.ai"
                  - name: ALLOWED_ORIGINS
                    value: "https://studio-staging.shogo.ai,https://api-staging.shogo.ai"
                  - name: REDIS_URL
                    valueFrom:
                      secretKeyRef:
                        name: redis-credentials
                        key: REDIS_URL
                        optional: true
                  - name: DATABASE_URL
                    valueFrom:
                      secretKeyRef:
                        name: postgres-credentials
                        key: DATABASE_URL
                  - name: BETTER_AUTH_SECRET
                    valueFrom:
                      secretKeyRef:
                        name: api-secrets
                        key: BETTER_AUTH_SECRET
                  # Pod-per-project configuration
                  - name: PROJECT_RUNTIME_IMAGE
                    value: "${local.ecr_registry}/shogo/project-runtime:${local.image_tag}"
                  - name: AGENT_RUNTIME_IMAGE
                    value: "${local.ecr_registry}/shogo/agent-runtime:${local.image_tag}"
                  - name: PROJECT_NAMESPACE
                    value: "shogo-staging-workspaces"
                  - name: ANTHROPIC_API_KEY
                    valueFrom:
                      secretKeyRef:
                        name: api-secrets
                        key: ANTHROPIC_API_KEY
                        optional: true
                  # Shared PostgreSQL configuration (CloudNativePG)
                  - name: POSTGRES_ENABLED
                    value: "true"
                  - name: PROJECTS_DB_ADMIN_URL
                    valueFrom:
                      secretKeyRef:
                        name: projects-db-admin
                        key: PROJECTS_DB_ADMIN_URL
                        optional: true
                  - name: PROJECTS_DB_HOST
                    value: "projects-pg-rw.shogo-staging-system.svc.cluster.local"
                  - name: PROJECTS_DB_PORT
                    value: "5432"
                  - name: PROJECT_IDLE_TIMEOUT
                    value: "${var.project_runtime_idle_timeout}"
                  # S3 configuration for workspace file persistence (emptyDir + S3 sync)
                  - name: S3_WORKSPACES_BUCKET
                    value: "${aws_s3_bucket.workspaces.id}"
                  - name: S3_REGION
                    value: "${var.aws_region}"
                  # Publish configuration (S3 + CloudFront)
                  - name: PUBLISH_BUCKET
                    value: "shogo-published-apps-${var.environment}"
                  - name: PUBLISH_CLOUDFRONT_ID
                    value: ""
                  - name: PUBLISH_DOMAIN
                    value: "${var.publish_domain}"
                  # Warm pool sizing (scale up for concurrent users)
                  - name: WARM_POOL_PROJECT_SIZE
                    value: "4"
                  - name: WARM_POOL_AGENT_SIZE
                    value: "4"
                  - name: WARM_POOL_MAX_AGE_MS
                    value: "3600000"
                  # OpenTelemetry tracing → SigNoz Cloud
                  - name: OTEL_EXPORTER_OTLP_ENDPOINT
                    value: "https://${var.signoz_endpoint}"
                  - name: OTEL_SERVICE_NAME
                    value: "shogo-api-staging"
                  - name: SIGNOZ_INGESTION_KEY
                    valueFrom:
                      secretKeyRef:
                        name: signoz-credentials
                        key: SIGNOZ_INGESTION_KEY
                        optional: true
                resources:
                  requests:
                    memory: "512Mi"
                    cpu: "100m"
                  limits:
                    memory: "2Gi"
                    cpu: "500m"
      EOF

      # Deploy MCP Workspace Service
      # IMPORTANT: min-scale: 1 keeps pod always running to preserve meta-store state.
      # Scaling to zero loses all loaded schemas, causing query failures.
      cat <<EOF | kubectl apply -f -
      apiVersion: serving.knative.dev/v1
      kind: Service
      metadata:
        name: mcp-workspace-1
        namespace: shogo-staging-workspaces
        labels:
          app.kubernetes.io/part-of: shogo
          environment: staging
      spec:
        template:
          metadata:
            annotations:
              # Keep at least 1 pod running to preserve meta-store state
              autoscaling.knative.dev/min-scale: "1"
              autoscaling.knative.dev/max-scale: "3"
              autoscaling.knative.dev/target: "100"
          spec:
            timeoutSeconds: 300
            containers:
              - name: mcp
                image: ${local.ecr_registry}/shogo/shogo-mcp:${local.image_tag}
                ports:
                  - containerPort: 8080
                env:
                  - name: MCP_PORT
                    value: "8080"
                  - name: NODE_ENV
                    value: "staging"
                  - name: NODE_TLS_REJECT_UNAUTHORIZED
                    value: "0"
                  - name: SCHEMAS_PATH
                    value: "/app/.schemas"
                  - name: WORKSPACE_ID
                    value: "workspace-1"
                  - name: TENANT_ID
                    value: "staging-tenant"
                  - name: DATABASE_URL
                    valueFrom:
                      secretKeyRef:
                        name: postgres-credentials
                        key: DATABASE_URL
                  # OpenTelemetry tracing → SigNoz Cloud
                  - name: OTEL_EXPORTER_OTLP_ENDPOINT
                    value: "https://${var.signoz_endpoint}"
                  - name: OTEL_SERVICE_NAME
                    value: "shogo-mcp-staging"
                  - name: SIGNOZ_INGESTION_KEY
                    valueFrom:
                      secretKeyRef:
                        name: signoz-credentials
                        key: SIGNOZ_INGESTION_KEY
                        optional: true
                resources:
                  requests:
                    memory: "256Mi"
                    cpu: "100m"
                  limits:
                    memory: "512Mi"
                    cpu: "500m"
                # Startup probe: TCP check on main MCP port
                startupProbe:
                  tcpSocket:
                    port: 8080
                  initialDelaySeconds: 10
                  periodSeconds: 5
                  timeoutSeconds: 5
                  failureThreshold: 12
                # Readiness probe: TCP check ensures MCP server is listening
                readinessProbe:
                  tcpSocket:
                    port: 8080
                  initialDelaySeconds: 5
                  periodSeconds: 10
                  timeoutSeconds: 5
                  failureThreshold: 3
      EOF

      # Deploy Domain Mappings
      cat <<EOF | kubectl apply -f -
      apiVersion: serving.knative.dev/v1beta1
      kind: DomainMapping
      metadata:
        name: studio-staging.shogo.ai
        namespace: shogo-staging-system
      spec:
        ref:
          name: studio
          kind: Service
          apiVersion: serving.knative.dev/v1
      ---
      apiVersion: serving.knative.dev/v1beta1
      kind: DomainMapping
      metadata:
        name: mcp-staging.shogo.ai
        namespace: shogo-staging-workspaces
      spec:
        ref:
          name: mcp-workspace-1
          kind: Service
          apiVersion: serving.knative.dev/v1
      EOF

      # NOTE: Image pre-puller DaemonSet is deployed via kustomize overlay
      # (k8s/overlays/staging/image-prepuller.yaml) to shogo-staging-system namespace
      # Do NOT deploy it here to avoid duplicate DaemonSets causing disk pressure

      # Wait for services to be ready
      echo "Waiting for services to be ready..."
      kubectl wait --for=condition=ready ksvc/studio -n shogo-staging-system --timeout=300s || true
      kubectl wait --for=condition=ready ksvc/api -n shogo-staging-system --timeout=300s || true
      kubectl wait --for=condition=ready ksvc/mcp-workspace-1 -n shogo-staging-workspaces --timeout=300s || true
      
      echo "Knative services deployed successfully"
    EOT
  }
}

# -----------------------------------------------------------------------------
# Publish Hosting (S3 + CloudFront for published apps)
# -----------------------------------------------------------------------------
# This module creates the infrastructure for serving published static apps
# at *.shogo.one via CloudFront CDN backed by S3.
# -----------------------------------------------------------------------------

module "publish_hosting" {
  source = "../../modules/publish-hosting"

  count = var.ssl_certificate_domain_publish != "" ? 1 : 0

  environment         = var.environment
  publish_domain      = var.publish_domain
  acm_certificate_arn = data.aws_acm_certificate.ssl_publish[0].arn

  tags = {
    Environment = var.environment
  }
}

# IAM Policy for API to upload published apps to S3
resource "aws_iam_policy" "api_publish_s3_access" {
  count       = var.ssl_certificate_domain_publish != "" ? 1 : 0
  name        = "shogo-api-publish-s3-${var.environment}"
  description = "Allow API to upload published apps to S3"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket"
        ]
        Resource = [
          module.publish_hosting[0].bucket_arn,
          "${module.publish_hosting[0].bucket_arn}/*"
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "cloudfront:CreateInvalidation"
        ]
        Resource = [
          module.publish_hosting[0].cloudfront_distribution_arn
        ]
      }
    ]
  })
}

# Attach publish S3 policy to EKS node role (so API pods can upload to S3)
resource "aws_iam_role_policy_attachment" "node_publish_s3_access" {
  count      = var.ssl_certificate_domain_publish != "" ? 1 : 0
  policy_arn = aws_iam_policy.api_publish_s3_access[0].arn
  role       = module.eks.node_role_name
}

# Kubernetes secret for publish configuration
resource "kubernetes_secret" "publish_config" {
  count      = var.ssl_certificate_domain_publish != "" ? 1 : 0
  depends_on = [kubernetes_namespace.shogo_system]

  metadata {
    name      = "publish-config"
    namespace = "shogo-staging-system"
  }

  data = {
    "bucket-name"      = module.publish_hosting[0].bucket_name
    "cloudfront-id"    = module.publish_hosting[0].cloudfront_distribution_id
    "publish-domain"   = var.publish_domain
    "region"           = var.aws_region
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
#   eks_cluster_arns    = [module.eks.cluster_arn]
#   ecr_repository_arns = [
#     "arn:aws:ecr:${var.aws_region}:${data.aws_caller_identity.current.account_id}:repository/shogo/shogo-mcp",
#     "arn:aws:ecr:${var.aws_region}:${data.aws_caller_identity.current.account_id}:repository/shogo/shogo-api",
#     "arn:aws:ecr:${var.aws_region}:${data.aws_caller_identity.current.account_id}:repository/shogo/shogo-web"
#   ]
# }
