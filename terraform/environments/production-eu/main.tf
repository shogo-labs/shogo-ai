# =============================================================================
# Shogo AI - Production EU EKS Deployment (Secondary Region)
# =============================================================================
# Region: eu-west-1
# Role: Active-active secondary cluster for multi-region deployment
# Database: CloudNativePG replica (read-only, streams from us-east-1 primary)
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

  backend "s3" {
    bucket  = "shogo-terraform-state"
    key     = "production-eu/terraform.tfstate"
    region  = "us-east-1"
    encrypt = true
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
      Region      = var.aws_region
      Project     = "shogo-ai"
      ManagedBy   = "terraform"
    }
  }
}

# Secondary provider for cross-region resources (ECR replication, etc.)
provider "aws" {
  alias  = "primary"
  region = var.primary_region

  default_tags {
    tags = {
      Environment = var.environment
      Project     = "shogo-ai"
      ManagedBy   = "terraform"
    }
  }
}

# EKS Cluster Data Sources
locals {
  eks_cluster_name = "${var.project_name}-${var.environment}-${var.environment_suffix}"
}

data "aws_eks_cluster" "cluster" {
  count = var.bootstrap_mode ? 0 : 1
  name  = local.eks_cluster_name
}

data "aws_eks_cluster_auth" "cluster" {
  count = var.bootstrap_mode ? 0 : 1
  name  = local.eks_cluster_name
}

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

# ACM certificates in eu-west-1 (must be provisioned separately)
data "aws_acm_certificate" "ssl" {
  count       = var.ssl_certificate_domain != "" ? 1 : 0
  domain      = var.ssl_certificate_domain
  statuses    = ["ISSUED"]
  most_recent = true
  types       = ["AMAZON_ISSUED"]
}

data "aws_acm_certificate" "ssl_publish" {
  count       = var.ssl_certificate_domain_publish != "" ? 1 : 0
  domain      = var.ssl_certificate_domain_publish
  statuses    = ["ISSUED"]
  most_recent = true
  types       = ["AMAZON_ISSUED"]
}

# -----------------------------------------------------------------------------
# VPC Module (non-overlapping CIDR for potential VPC peering)
# -----------------------------------------------------------------------------
module "vpc" {
  source = "../../modules/vpc"

  name               = "${var.project_name}-${var.environment}-${var.environment_suffix}"
  cidr               = var.vpc_cidr
  availability_zones = slice(data.aws_availability_zones.available.names, 0, 3)

  single_nat_gateway = true

  tags = {
    "kubernetes.io/cluster/${local.eks_cluster_name}" = "shared"
  }
}

# -----------------------------------------------------------------------------
# EKS Cluster (no ECR module - images replicated from us-east-1)
# -----------------------------------------------------------------------------
module "eks" {
  source = "../../modules/eks"

  cluster_name    = local.eks_cluster_name
  cluster_version = var.eks_cluster_version

  vpc_id          = module.vpc.vpc_id
  private_subnets = module.vpc.private_subnet_ids

  node_instance_types = var.node_instance_types
  node_desired_size   = var.node_desired_size
  node_min_size       = var.node_min_size
  node_max_size       = var.node_max_size
  node_disk_size      = 50

  enable_secondary_node_group = var.enable_secondary_node_group
  enable_karpenter            = true

  admin_role_arns = [
    "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${var.project_name}-github-actions"
  ]

  tags = {
    Environment = var.environment
    Region      = var.aws_region
  }
}

# -----------------------------------------------------------------------------
# Karpenter
# -----------------------------------------------------------------------------
module "karpenter" {
  count  = var.bootstrap_mode ? 0 : 1
  source = "../../modules/karpenter"

  depends_on = [module.eks]

  cluster_name      = module.eks.cluster_name
  cluster_arn       = module.eks.cluster_arn
  cluster_endpoint  = module.eks.cluster_endpoint
  oidc_provider_arn = module.eks.oidc_provider_arn
  oidc_provider_url = module.eks.oidc_provider_url
  node_role_arn     = module.eks.node_role_arn
  node_role_name    = module.eks.node_role_name

  tags = {
    Environment = var.environment
  }
}

resource "aws_eks_access_entry" "karpenter_nodes" {
  count = var.bootstrap_mode ? 0 : 1

  cluster_name  = module.eks.cluster_name
  principal_arn = module.eks.node_role_arn
  type          = "EC2_LINUX"

  depends_on = [module.eks]
}

resource "helm_release" "karpenter" {
  count = var.bootstrap_mode ? 0 : 1

  namespace        = "kube-system"
  name             = "karpenter"
  repository       = "oci://public.ecr.aws/karpenter"
  chart            = "karpenter"
  version          = "1.9.0"
  wait             = true
  create_namespace = false

  values = [yamlencode({
    settings = {
      clusterName       = module.eks.cluster_name
      clusterEndpoint   = module.eks.cluster_endpoint
      interruptionQueue = module.karpenter[0].queue_name
    }
    serviceAccount = {
      annotations = {
        "eks.amazonaws.com/role-arn" = module.karpenter[0].controller_role_arn
      }
    }
    controller = {
      resources = {
        requests = {
          cpu    = "100m"
          memory = "256Mi"
        }
        limits = {
          cpu    = "500m"
          memory = "512Mi"
        }
      }
    }
    replicas = 1
  })]

  depends_on = [
    module.eks,
    module.karpenter[0],
  ]
}

resource "null_resource" "karpenter_node_pool" {
  count = var.bootstrap_mode ? 0 : 1

  triggers = {
    node_pool_hash = sha256(jsonencode({
      instance_types = ["t3.xlarge", "t3.2xlarge", "m5.xlarge", "m5.2xlarge"]
      cluster_name   = module.eks.cluster_name
      node_role_name = module.eks.node_role_name
      node_sg        = module.eks.node_security_group_id
      eks_sg         = module.eks.eks_managed_security_group_id
    }))
  }

  provisioner "local-exec" {
    command = <<-EOT
      echo "Waiting for Karpenter CRDs..."
      for i in $(seq 1 30); do
        if kubectl get crd nodepools.karpenter.sh > /dev/null 2>&1; then
          echo "Karpenter CRDs ready"
          break
        fi
        echo "Waiting for CRDs... (attempt $i)"
        sleep 5
      done

      cat <<EOF | kubectl apply -f -
      apiVersion: karpenter.sh/v1
      kind: NodePool
      metadata:
        name: default
      spec:
        template:
          spec:
            requirements:
              - key: kubernetes.io/arch
                operator: In
                values: ["amd64"]
              - key: karpenter.sh/capacity-type
                operator: In
                values: ["on-demand"]
              - key: node.kubernetes.io/instance-type
                operator: In
                values: ["t3.xlarge", "t3.2xlarge", "m5.xlarge", "m5.2xlarge"]
            nodeClassRef:
              group: karpenter.k8s.aws
              kind: EC2NodeClass
              name: default
        limits:
          cpu: "64"
          memory: "128Gi"
        disruption:
          consolidationPolicy: WhenEmptyOrUnderutilized
          consolidateAfter: 60s
      ---
      apiVersion: karpenter.k8s.aws/v1
      kind: EC2NodeClass
      metadata:
        name: default
      spec:
        amiSelectorTerms:
          - alias: bottlerocket@latest
        role: "${module.eks.node_role_name}"
        subnetSelectorTerms:
          - tags:
              karpenter.sh/discovery: "${local.eks_cluster_name}"
        securityGroupSelectorTerms:
          - id: "${module.eks.node_security_group_id}"
          - id: "${module.eks.eks_managed_security_group_id}"
        blockDeviceMappings:
          - deviceName: /dev/xvdb
            ebs:
              volumeSize: 50Gi
              volumeType: gp3
              encrypted: true
              deleteOnTermination: true
      EOF
    EOT
  }

  depends_on = [helm_release.karpenter[0]]
}

# -----------------------------------------------------------------------------
# CloudNativePG Operator
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

  cluster_id = "${var.project_name}-${var.environment}-${var.environment_suffix}"

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnet_ids
  security_group_ids = [
    module.eks.cluster_security_group_id,
    module.eks.node_security_group_id,
    module.eks.eks_managed_security_group_id
  ]

  node_type       = var.redis_node_type
  num_cache_nodes = 1

  tags = {
    Environment = var.environment
    Region      = var.aws_region
  }
}

# -----------------------------------------------------------------------------
# VPC Endpoints (for private subnet access to AWS services)
# -----------------------------------------------------------------------------
resource "aws_security_group" "vpc_endpoints" {
  name        = "${var.project_name}-${var.environment}-${var.environment_suffix}-vpc-endpoints-sg"
  description = "Security group for VPC endpoints"
  vpc_id      = module.vpc.vpc_id

  ingress {
    description     = "HTTPS from EKS nodes"
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    security_groups = [module.eks.node_security_group_id]
  }

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
    Name        = "${var.project_name}-${var.environment}-${var.environment_suffix}-vpc-endpoints-sg"
    Environment = var.environment
  }
}

resource "aws_vpc_endpoint" "ecr_api" {
  vpc_id              = module.vpc.vpc_id
  service_name        = "com.amazonaws.${var.aws_region}.ecr.api"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = module.vpc.private_subnet_ids
  security_group_ids  = [aws_security_group.vpc_endpoints.id]
  private_dns_enabled = true

  tags = {
    Name        = "${var.project_name}-${var.environment}-${var.environment_suffix}-ecr-api"
    Environment = var.environment
  }
}

resource "aws_vpc_endpoint" "ecr_dkr" {
  vpc_id              = module.vpc.vpc_id
  service_name        = "com.amazonaws.${var.aws_region}.ecr.dkr"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = module.vpc.private_subnet_ids
  security_group_ids  = [aws_security_group.vpc_endpoints.id]
  private_dns_enabled = true

  tags = {
    Name        = "${var.project_name}-${var.environment}-${var.environment_suffix}-ecr-dkr"
    Environment = var.environment
  }
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = module.vpc.vpc_id
  service_name      = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = module.vpc.private_route_table_ids

  tags = {
    Name        = "${var.project_name}-${var.environment}-${var.environment_suffix}-s3"
    Environment = var.environment
  }
}

# -----------------------------------------------------------------------------
# AWS Load Balancer Controller
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
# -----------------------------------------------------------------------------
module "knative" {
  count  = var.bootstrap_mode ? 0 : 1
  source = "../../modules/knative"

  depends_on = [module.eks, module.aws_lb_controller[0]]

  knative_version = var.knative_version
  domain          = var.domain
  publish_domain  = var.publish_domain

  scale_to_zero_grace_period = "60s"
  enable_pvc_support         = true

  ssl_certificate_arn = var.ssl_certificate_domain != "" ? data.aws_acm_certificate.ssl[0].arn : ""

  ecr_registry = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.aws_region}.amazonaws.com"
}

# -----------------------------------------------------------------------------
# Kubernetes Namespaces
# -----------------------------------------------------------------------------
resource "kubernetes_namespace" "shogo_system" {
  count      = var.bootstrap_mode ? 0 : 1
  depends_on = [module.eks]

  metadata {
    name = "shogo-system"
    labels = {
      "app.kubernetes.io/part-of" = "shogo"
    }
  }
}

resource "kubernetes_namespace" "shogo_workspaces" {
  count      = var.bootstrap_mode ? 0 : 1
  depends_on = [module.eks]

  metadata {
    name = "shogo-workspaces"
    labels = {
      "app.kubernetes.io/part-of" = "shogo"
    }
  }
}

# -----------------------------------------------------------------------------
# CloudNativePG Replica Clusters (read-only, streams from us-east-1)
# -----------------------------------------------------------------------------
resource "null_resource" "cnpg_clusters" {
  count = var.bootstrap_mode ? 0 : 1

  depends_on = [
    module.cnpg[0],
    module.eks,
    kubernetes_namespace.shogo_system[0],
  ]

  triggers = {
    platform_hash = filemd5("${path.module}/../../../k8s/cnpg/production-eu/platform-cluster.yaml")
    projects_hash = filemd5("${path.module}/../../../k8s/cnpg/production-eu/projects-cluster.yaml")
  }

  provisioner "local-exec" {
    command = <<-EOT
      echo "Waiting for CloudNativePG operator to be ready..."
      kubectl wait --for=condition=Available deployment -l app.kubernetes.io/name=cloudnative-pg -n cnpg-system --timeout=120s || true

      echo "Deploying CloudNativePG replica clusters (read-only)..."
      kubectl apply -f ${path.module}/../../../k8s/cnpg/production-eu/platform-cluster.yaml
      kubectl apply -f ${path.module}/../../../k8s/cnpg/production-eu/projects-cluster.yaml

      echo "Waiting for replica clusters to be ready..."
      kubectl wait --for=condition=Ready cluster/platform-pg -n shogo-system --timeout=300s || true
      kubectl wait --for=condition=Ready cluster/projects-pg -n shogo-system --timeout=300s || true

      echo "CloudNativePG replica clusters deployed"
    EOT
  }
}

# Database credentials (points to local replica for reads, primary for writes)
resource "null_resource" "postgres_credentials" {
  count = var.bootstrap_mode ? 0 : 1

  depends_on = [
    kubernetes_namespace.shogo_system[0],
    kubernetes_namespace.shogo_workspaces[0],
    null_resource.cnpg_clusters[0],
  ]

  triggers = {
    timestamp = timestamp()
  }

  provisioner "local-exec" {
    command = <<-EOT
      echo "Waiting for CloudNativePG platform-pg-app secret..."
      for i in $(seq 1 60); do
        if kubectl get secret platform-pg-app -n shogo-system > /dev/null 2>&1; then
          echo "Secret platform-pg-app found"
          break
        fi
        echo "Waiting... (attempt $i)"
        sleep 5
      done

      PLATFORM_URI=$(kubectl get secret platform-pg-app -n shogo-system -o jsonpath='{.data.uri}' | base64 -d)

      if [ -z "$PLATFORM_URI" ]; then
        echo "ERROR: Could not extract platform-pg URI"
        exit 1
      fi

      kubectl create secret generic postgres-credentials \
        --namespace shogo-system \
        --from-literal=DATABASE_URL="$PLATFORM_URI" \
        --dry-run=client -o yaml | kubectl apply -f -

      kubectl create secret generic postgres-credentials \
        --namespace shogo-workspaces \
        --from-literal=DATABASE_URL="$PLATFORM_URI" \
        --dry-run=client -o yaml | kubectl apply -f -

      echo "Waiting for CloudNativePG projects-pg-superuser secret..."
      for i in $(seq 1 60); do
        if kubectl get secret projects-pg-superuser -n shogo-system > /dev/null 2>&1; then
          echo "Secret projects-pg-superuser found"
          break
        fi
        sleep 5
      done

      PROJECTS_ADMIN_URI=$(kubectl get secret projects-pg-superuser -n shogo-system -o jsonpath='{.data.uri}' | base64 -d)

      if [ -n "$PROJECTS_ADMIN_URI" ]; then
        kubectl create secret generic projects-db-admin \
          --namespace shogo-system \
          --from-literal=PROJECTS_DB_ADMIN_URL="$PROJECTS_ADMIN_URI" \
          --from-literal=PROJECTS_DB_HOST="projects-pg-rw.shogo-system.svc.cluster.local" \
          --from-literal=PROJECTS_DB_PORT="5432" \
          --dry-run=client -o yaml | kubectl apply -f -
      fi

      echo "All database secrets created successfully"
    EOT
  }
}

# S3 credentials for CNPG backups
resource "kubernetes_secret" "cnpg_s3_credentials" {
  count      = var.bootstrap_mode ? 0 : 1
  depends_on = [kubernetes_namespace.shogo_system[0]]

  metadata {
    name      = "cnpg-s3-credentials"
    namespace = "shogo-system"
  }

  data = {
    ACCESS_KEY_ID     = var.cnpg_s3_access_key_id
    SECRET_ACCESS_KEY = var.cnpg_s3_secret_access_key
    REGION            = var.aws_region
  }
}

# S3 bucket for PG backups in eu-west-1
resource "aws_s3_bucket" "pg_backups" {
  bucket = "shogo-pg-backups-${var.environment}-${var.environment_suffix}"

  tags = {
    Name        = "shogo-pg-backups-${var.environment}-${var.environment_suffix}"
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
  bucket                  = aws_s3_bucket.pg_backups.id
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
    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }
    expiration {
      days = 180
    }
  }
}

resource "aws_iam_policy" "cnpg_s3_backup" {
  name        = "shogo-cnpg-s3-backup-${var.environment}-${var.environment_suffix}"
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

# Redis credentials
resource "kubernetes_secret" "redis_credentials" {
  count      = var.bootstrap_mode ? 0 : 1
  depends_on = [kubernetes_namespace.shogo_system[0]]

  metadata {
    name      = "redis-credentials"
    namespace = "shogo-system"
  }

  data = {
    REDIS_URL = "redis://${module.elasticache.endpoint}:6379"
  }
}

# API secrets
resource "kubernetes_secret" "api_secrets" {
  count      = var.bootstrap_mode ? 0 : 1
  depends_on = [kubernetes_namespace.shogo_system[0]]

  metadata {
    name      = "api-secrets"
    namespace = "shogo-system"
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

# Anthropic credentials for workspace pods
resource "kubernetes_secret" "anthropic_credentials_workspaces" {
  count      = var.bootstrap_mode || var.anthropic_api_key == "" ? 0 : 1
  depends_on = [kubernetes_namespace.shogo_workspaces[0]]

  metadata {
    name      = "anthropic-credentials"
    namespace = "shogo-workspaces"
  }

  data = {
    api-key = var.anthropic_api_key
  }
}

# S3 bucket for workspace files in eu-west-1
resource "aws_s3_bucket" "workspaces" {
  bucket = "shogo-workspaces-${var.environment}-${var.environment_suffix}"

  tags = {
    Name        = "shogo-workspaces-${var.environment}-${var.environment_suffix}"
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
  bucket                  = aws_s3_bucket.workspaces.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "workspaces" {
  bucket = aws_s3_bucket.workspaces.id
  rule {
    id     = "cleanup-old-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}

resource "aws_iam_policy" "project_runtime_s3_access" {
  name        = "shogo-project-runtime-s3-${var.environment}-${var.environment_suffix}"
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

resource "aws_iam_role_policy_attachment" "node_s3_access" {
  policy_arn = aws_iam_policy.project_runtime_s3_access.arn
  role       = module.eks.node_role_name
}

resource "kubernetes_secret" "s3_credentials_workspaces" {
  count      = var.bootstrap_mode ? 0 : 1
  depends_on = [kubernetes_namespace.shogo_workspaces[0]]

  metadata {
    name      = "s3-credentials"
    namespace = "shogo-workspaces"
  }

  data = {
    "workspaces-bucket" = aws_s3_bucket.workspaces.id
    "region"            = var.aws_region
  }
}

# Storage class for EBS CSI
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
# Knative Services
# -----------------------------------------------------------------------------
locals {
  ecr_registry = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.aws_region}.amazonaws.com"
  image_tag    = "${var.environment}-latest"
}

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
    image_tag    = local.image_tag
    ecr_registry = local.ecr_registry
  }

  provisioner "local-exec" {
    command = <<-EOT
      kubectl wait --for=condition=Available deployment/controller -n knative-serving --timeout=120s || true

      # Deploy Studio (Web) Service
      cat <<EOF | kubectl apply -f -
      apiVersion: serving.knative.dev/v1
      kind: Service
      metadata:
        name: studio
        namespace: shogo-system
        labels:
          app.kubernetes.io/part-of: shogo
          environment: production
          region: ${var.aws_region}
      spec:
        template:
          metadata:
            annotations:
              autoscaling.knative.dev/min-scale: "1"
              autoscaling.knative.dev/max-scale: "10"
          spec:
            containers:
              - name: web
                image: ${local.ecr_registry}/shogo/shogo-web:${local.image_tag}
                imagePullPolicy: Always
                ports:
                  - containerPort: 80
                env:
                  - name: API_UPSTREAM
                    value: "http://api.shogo-system.svc.cluster.local"
                  - name: API_HOST
                    value: "api.shogo-system.svc.cluster.local"
                  - name: MCP_UPSTREAM
                    value: "http://mcp-workspace-1.shogo-workspaces.svc.cluster.local"
                  - name: MCP_HOST
                    value: "mcp-workspace-1.shogo-workspaces.svc.cluster.local"
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
        namespace: shogo-system
        labels:
          app.kubernetes.io/part-of: shogo
          environment: production
          region: ${var.aws_region}
      spec:
        template:
          metadata:
            annotations:
              autoscaling.knative.dev/min-scale: "1"
              autoscaling.knative.dev/max-scale: "10"
          spec:
            containers:
              - name: api
                image: ${local.ecr_registry}/shogo/shogo-api:${local.image_tag}
                imagePullPolicy: Always
                ports:
                  - containerPort: 8002
                env:
                  - name: API_PORT
                    value: "8002"
                  - name: NODE_ENV
                    value: "production"
                  - name: REGION
                    value: "${var.aws_region}"
                  - name: MCP_URL
                    value: "http://mcp-workspace-1.shogo-workspaces.svc.cluster.local"
                  - name: BETTER_AUTH_URL
                    value: "https://studio.shogo.ai"
                  - name: ALLOWED_ORIGINS
                    value: "https://studio.shogo.ai"
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
                  - name: PROJECT_RUNTIME_IMAGE
                    value: "${local.ecr_registry}/shogo/project-runtime:${local.image_tag}"
                  - name: AGENT_RUNTIME_IMAGE
                    value: "${local.ecr_registry}/shogo/agent-runtime:${local.image_tag}"
                  - name: PROJECT_NAMESPACE
                    value: "shogo-workspaces"
                  - name: ANTHROPIC_API_KEY
                    valueFrom:
                      secretKeyRef:
                        name: api-secrets
                        key: ANTHROPIC_API_KEY
                        optional: true
                  - name: POSTGRES_ENABLED
                    value: "true"
                  - name: PROJECTS_DB_ADMIN_URL
                    valueFrom:
                      secretKeyRef:
                        name: projects-db-admin
                        key: PROJECTS_DB_ADMIN_URL
                        optional: true
                  - name: PROJECTS_DB_HOST
                    value: "projects-pg-rw.shogo-system.svc.cluster.local"
                  - name: PROJECTS_DB_PORT
                    value: "5432"
                  - name: PROJECT_IDLE_TIMEOUT
                    value: "${var.project_runtime_idle_timeout}"
                  - name: S3_WORKSPACES_BUCKET
                    value: "${aws_s3_bucket.workspaces.id}"
                  - name: S3_REGION
                    value: "${var.aws_region}"
                resources:
                  requests:
                    memory: "512Mi"
                    cpu: "100m"
                  limits:
                    memory: "2Gi"
                    cpu: "500m"
      EOF

      # Deploy MCP Workspace Service
      cat <<EOF | kubectl apply -f -
      apiVersion: serving.knative.dev/v1
      kind: Service
      metadata:
        name: mcp-workspace-1
        namespace: shogo-workspaces
        labels:
          app.kubernetes.io/part-of: shogo
          environment: production
          region: ${var.aws_region}
      spec:
        template:
          metadata:
            annotations:
              autoscaling.knative.dev/min-scale: "1"
              autoscaling.knative.dev/max-scale: "10"
              autoscaling.knative.dev/target: "100"
          spec:
            timeoutSeconds: 300
            containers:
              - name: mcp
                image: ${local.ecr_registry}/shogo/shogo-mcp:${local.image_tag}
                imagePullPolicy: Always
                ports:
                  - containerPort: 8080
                env:
                  - name: MCP_PORT
                    value: "8080"
                  - name: NODE_ENV
                    value: "production"
                  - name: SCHEMAS_PATH
                    value: "/app/.schemas"
                  - name: WORKSPACE_ID
                    value: "workspace-1"
                  - name: TENANT_ID
                    value: "production-tenant"
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
                startupProbe:
                  tcpSocket:
                    port: 8080
                  initialDelaySeconds: 10
                  periodSeconds: 5
                  timeoutSeconds: 5
                  failureThreshold: 12
                readinessProbe:
                  tcpSocket:
                    port: 8080
                  initialDelaySeconds: 5
                  periodSeconds: 10
                  timeoutSeconds: 5
                  failureThreshold: 3
      EOF

      echo "Waiting for services to be ready..."
      kubectl wait --for=condition=ready ksvc/studio -n shogo-system --timeout=300s || true
      kubectl wait --for=condition=ready ksvc/api -n shogo-system --timeout=300s || true
      kubectl wait --for=condition=ready ksvc/mcp-workspace-1 -n shogo-workspaces --timeout=300s || true

      echo "Knative services deployed to eu-west-1"
    EOT
  }
}
