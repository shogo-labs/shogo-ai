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

  # Grant cluster-admin access to GitHub Actions role (shared with production)
  admin_role_arns = [
    "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${var.project_name}-github-actions"
  ]

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
# -----------------------------------------------------------------------------
module "aws_lb_controller" {
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
# -----------------------------------------------------------------------------
module "knative" {
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

  # ECR registry - skip tag resolution (avoids auth issues with Knative controller)
  ecr_registry = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.aws_region}.amazonaws.com"
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
    # Include sslmode=require for AWS RDS SSL connections
    DATABASE_URL = "postgres://${module.rds.username}:${module.rds.password}@${module.rds.endpoint}/${module.rds.database_name}?sslmode=require"
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
    # Include sslmode=require for AWS RDS SSL connections
    DATABASE_URL = "postgres://${module.rds.username}:${module.rds.password}@${module.rds.endpoint}/${module.rds.database_name}?sslmode=require"
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

  data = merge(
    {
      BETTER_AUTH_SECRET = var.better_auth_secret
    },
    var.anthropic_api_key != "" ? {
      ANTHROPIC_API_KEY = var.anthropic_api_key
    } : {}
  )
}

# Anthropic credentials for project pods (shogo-staging-workspaces namespace)
resource "kubernetes_secret" "anthropic_credentials_workspaces" {
  count      = var.anthropic_api_key != "" ? 1 : 0
  depends_on = [kubernetes_namespace.shogo_workspaces]

  metadata {
    name      = "anthropic-credentials"
    namespace = "shogo-staging-workspaces"
  }

  data = {
    api-key = var.anthropic_api_key
  }
}

# -----------------------------------------------------------------------------
# Storage Class for EBS CSI Driver (for project PVCs)
# -----------------------------------------------------------------------------
resource "kubernetes_storage_class" "ebs_sc" {
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
  depends_on = [
    module.knative,
    kubernetes_namespace.shogo_system,
    kubernetes_namespace.shogo_workspaces,
    kubernetes_secret.postgres_credentials,
    kubernetes_secret.postgres_credentials_workspaces,
    kubernetes_secret.redis_credentials,
    kubernetes_secret.api_secrets
  ]

  triggers = {
    # Trigger redeployment when image tag changes
    image_tag    = local.image_tag
    ecr_registry = local.ecr_registry
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
                  - name: PROJECT_NAMESPACE
                    value: "shogo-staging-workspaces"
                  - name: ANTHROPIC_API_KEY
                    valueFrom:
                      secretKeyRef:
                        name: api-secrets
                        key: ANTHROPIC_API_KEY
                        optional: true
                resources:
                  requests:
                    memory: "256Mi"
                    cpu: "100m"
                  limits:
                    memory: "512Mi"
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
