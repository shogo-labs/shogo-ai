# =============================================================================
# EKS Module
# =============================================================================
# Creates an EKS cluster with managed node groups and optional Karpenter
# =============================================================================

variable "cluster_name" {
  description = "EKS cluster name"
  type        = string
}

variable "cluster_version" {
  description = "Kubernetes version (EKS supports up to 1.33 as of Jan 2026)"
  type        = string
  default     = "1.33"
}

variable "vpc_id" {
  description = "VPC ID"
  type        = string
}

variable "private_subnets" {
  description = "Private subnet IDs for EKS"
  type        = list(string)
}

variable "node_instance_types" {
  description = "Instance types for node group"
  type        = list(string)
  default     = ["t3.medium"]
}

variable "node_desired_size" {
  description = "Desired number of nodes"
  type        = number
  default     = 2
}

variable "node_min_size" {
  description = "Minimum number of nodes"
  type        = number
  default     = 1
}

variable "node_max_size" {
  description = "Maximum number of nodes"
  type        = number
  default     = 10
}

variable "enable_karpenter" {
  description = "Enable Karpenter for autoscaling"
  type        = bool
  default     = true
}

variable "enable_secondary_node_group" {
  description = "Enable secondary node group for additional capacity"
  type        = bool
  default     = false
}

variable "node_disk_size" {
  description = "Disk size in GB for node group instances"
  type        = number
  default     = 50
}

variable "secondary_node_instance_types" {
  description = "Instance types for secondary node group (defaults to primary node_instance_types)"
  type        = list(string)
  default     = null
}

variable "secondary_node_desired_size" {
  description = "Desired number of nodes in secondary node group (defaults to node_desired_size)"
  type        = number
  default     = null
}

variable "secondary_node_min_size" {
  description = "Minimum number of nodes in secondary node group (defaults to node_min_size)"
  type        = number
  default     = null
}

variable "secondary_node_max_size" {
  description = "Maximum number of nodes in secondary node group (defaults to node_max_size)"
  type        = number
  default     = null
}

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}

variable "admin_role_arns" {
  description = "List of IAM role ARNs to grant cluster-admin access (e.g., GitHub Actions role)"
  type        = list(string)
  default     = []
}

# -----------------------------------------------------------------------------
# EKS Cluster IAM Role
# -----------------------------------------------------------------------------
resource "aws_iam_role" "cluster" {
  name = "${var.cluster_name}-cluster-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "eks.amazonaws.com"
      }
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "cluster_policy" {
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
  role       = aws_iam_role.cluster.name
}

# -----------------------------------------------------------------------------
# EKS Cluster Security Group
# -----------------------------------------------------------------------------
resource "aws_security_group" "cluster" {
  name        = "${var.cluster_name}-cluster-sg"
  description = "EKS cluster security group"
  vpc_id      = var.vpc_id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, {
    Name = "${var.cluster_name}-cluster-sg"
  })
}

# -----------------------------------------------------------------------------
# EKS Cluster
# -----------------------------------------------------------------------------
resource "aws_eks_cluster" "main" {
  name     = var.cluster_name
  version  = var.cluster_version
  role_arn = aws_iam_role.cluster.arn

  vpc_config {
    subnet_ids              = var.private_subnets
    security_group_ids      = [aws_security_group.cluster.id]
    endpoint_private_access = true
    endpoint_public_access  = true
  }

  # Enable EKS access entries (modern IAM authentication)
  access_config {
    authentication_mode                         = "API_AND_CONFIG_MAP"
    bootstrap_cluster_creator_admin_permissions = true
  }

  # Enable EKS add-ons
  enabled_cluster_log_types = ["api", "audit", "authenticator", "controllerManager", "scheduler"]

  tags = var.tags

  depends_on = [
    aws_iam_role_policy_attachment.cluster_policy
  ]
}

# -----------------------------------------------------------------------------
# Node Group IAM Role
# -----------------------------------------------------------------------------
resource "aws_iam_role" "node_group" {
  name = "${var.cluster_name}-node-group-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "ec2.amazonaws.com"
      }
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "node_group_policies" {
  for_each = toset([
    "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
    "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
    "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
    "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
  ])

  policy_arn = each.value
  role       = aws_iam_role.node_group.name
}

# -----------------------------------------------------------------------------
# Node Security Group
# -----------------------------------------------------------------------------
resource "aws_security_group" "node" {
  name        = "${var.cluster_name}-node-sg"
  description = "EKS node security group"
  vpc_id      = var.vpc_id

  ingress {
    from_port       = 0
    to_port         = 0
    protocol        = "-1"
    security_groups = [aws_security_group.cluster.id]
  }

  ingress {
    from_port = 0
    to_port   = 0
    protocol  = "-1"
    self      = true
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # NOTE: Do NOT add kubernetes.io/cluster tag here!
  # The EKS-managed cluster security group already has this tag.
  # Adding it here causes "Multiple tagged security groups found" errors
  # when the AWS load balancer controller tries to create/update LBs.
  tags = merge(var.tags, {
    Name = "${var.cluster_name}-node-sg"
  })
}

# -----------------------------------------------------------------------------
# Launch Template for Node Group (to attach our security group)
# -----------------------------------------------------------------------------
resource "aws_launch_template" "node_group" {
  name_prefix = "${var.cluster_name}-node-"

  vpc_security_group_ids = [
    aws_security_group.node.id,
    aws_eks_cluster.main.vpc_config[0].cluster_security_group_id
  ]

  # Root volume configuration
  block_device_mappings {
    device_name = "/dev/xvda"

    ebs {
      volume_size           = var.node_disk_size
      volume_type           = "gp3"
      delete_on_termination = true
      encrypted             = true
    }
  }

  # Metadata options for IMDSv2 (recommended)
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }

  tag_specifications {
    resource_type = "instance"
    tags = merge(var.tags, {
      Name = "${var.cluster_name}-node"
    })
  }

  tags = var.tags
}

# -----------------------------------------------------------------------------
# EKS Managed Node Group
# -----------------------------------------------------------------------------
resource "aws_eks_node_group" "main" {
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "${var.cluster_name}-main"
  node_role_arn   = aws_iam_role.node_group.arn
  subnet_ids      = var.private_subnets

  instance_types = var.node_instance_types
  capacity_type  = "ON_DEMAND"

  # Use launch template to attach our security group and configure disk size
  launch_template {
    id      = aws_launch_template.node_group.id
    version = aws_launch_template.node_group.latest_version
  }

  scaling_config {
    desired_size = var.node_desired_size
    min_size     = var.node_min_size
    max_size     = var.node_max_size
  }

  update_config {
    max_unavailable = 1
  }

  labels = {
    "node.kubernetes.io/purpose" = "general"
  }

  tags = var.tags

  # Force recreation when launch template changes to ensure nodes get new disk size
  lifecycle {
    replace_triggered_by = [
      aws_launch_template.node_group.latest_version
    ]
  }

  depends_on = [
    aws_iam_role_policy_attachment.node_group_policies
  ]
}

# -----------------------------------------------------------------------------
# Secondary EKS Managed Node Group (optional, for additional capacity)
# -----------------------------------------------------------------------------
resource "aws_eks_node_group" "medium" {
  count = var.enable_secondary_node_group ? 1 : 0

  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "${var.cluster_name}-medium"
  node_role_arn   = aws_iam_role.node_group.arn
  subnet_ids      = var.private_subnets

  instance_types = coalesce(var.secondary_node_instance_types, var.node_instance_types)
  capacity_type  = "ON_DEMAND"

  # Use same launch template as primary node group (includes 50GB disk)
  launch_template {
    id      = aws_launch_template.node_group.id
    version = aws_launch_template.node_group.latest_version
  }

  scaling_config {
    desired_size = coalesce(var.secondary_node_desired_size, var.node_desired_size)
    min_size     = coalesce(var.secondary_node_min_size, var.node_min_size)
    max_size     = coalesce(var.secondary_node_max_size, var.node_max_size)
  }

  update_config {
    max_unavailable = 1
  }

  labels = {
    "node.kubernetes.io/purpose" = "general"
  }

  tags = var.tags

  # Force recreation when launch template changes to ensure nodes get new disk size
  lifecycle {
    replace_triggered_by = [
      aws_launch_template.node_group.latest_version
    ]
  }

  depends_on = [
    aws_iam_role_policy_attachment.node_group_policies
  ]
}

# -----------------------------------------------------------------------------
# EKS Add-ons
# -----------------------------------------------------------------------------
resource "aws_eks_addon" "vpc_cni" {
  cluster_name = aws_eks_cluster.main.name
  addon_name   = "vpc-cni"

  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "OVERWRITE"
}

resource "aws_eks_addon" "coredns" {
  cluster_name = aws_eks_cluster.main.name
  addon_name   = "coredns"

  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "OVERWRITE"

  depends_on = [aws_eks_node_group.main]
}

resource "aws_eks_addon" "kube_proxy" {
  cluster_name = aws_eks_cluster.main.name
  addon_name   = "kube-proxy"

  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "OVERWRITE"
}

# -----------------------------------------------------------------------------
# EBS CSI Driver (for PersistentVolumeClaims)
# -----------------------------------------------------------------------------
# IAM role for EBS CSI driver using IRSA (IAM Roles for Service Accounts)
resource "aws_iam_role" "ebs_csi_driver" {
  name = "${var.cluster_name}-ebs-csi-driver-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Federated = aws_iam_openid_connect_provider.cluster.arn
      }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "${replace(aws_eks_cluster.main.identity[0].oidc[0].issuer, "https://", "")}:aud" = "sts.amazonaws.com"
          "${replace(aws_eks_cluster.main.identity[0].oidc[0].issuer, "https://", "")}:sub" = "system:serviceaccount:kube-system:ebs-csi-controller-sa"
        }
      }
    }]
  })

  tags = var.tags

  depends_on = [aws_iam_openid_connect_provider.cluster]
}

resource "aws_iam_role_policy_attachment" "ebs_csi_driver" {
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy"
  role       = aws_iam_role.ebs_csi_driver.name
}

resource "aws_eks_addon" "ebs_csi_driver" {
  cluster_name             = aws_eks_cluster.main.name
  addon_name               = "aws-ebs-csi-driver"
  service_account_role_arn = aws_iam_role.ebs_csi_driver.arn

  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "OVERWRITE"

  depends_on = [
    aws_eks_node_group.main,
    aws_iam_role_policy_attachment.ebs_csi_driver
  ]
}

# -----------------------------------------------------------------------------
# EFS CSI Driver (for shared storage - supports multi-attach unlike EBS)
# -----------------------------------------------------------------------------
# IAM role for EFS CSI driver using IRSA (IAM Roles for Service Accounts)
resource "aws_iam_role" "efs_csi_driver" {
  name = "${var.cluster_name}-efs-csi-driver-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Federated = aws_iam_openid_connect_provider.cluster.arn
      }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringLike = {
          "${replace(aws_eks_cluster.main.identity[0].oidc[0].issuer, "https://", "")}:aud" = "sts.amazonaws.com"
          "${replace(aws_eks_cluster.main.identity[0].oidc[0].issuer, "https://", "")}:sub" = "system:serviceaccount:kube-system:efs-csi-*"
        }
      }
    }]
  })

  tags = var.tags

  depends_on = [aws_iam_openid_connect_provider.cluster]
}

resource "aws_iam_role_policy_attachment" "efs_csi_driver" {
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEFSCSIDriverPolicy"
  role       = aws_iam_role.efs_csi_driver.name
}

resource "aws_eks_addon" "efs_csi_driver" {
  cluster_name             = aws_eks_cluster.main.name
  addon_name               = "aws-efs-csi-driver"
  service_account_role_arn = aws_iam_role.efs_csi_driver.arn

  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "OVERWRITE"

  depends_on = [
    aws_eks_node_group.main,
    aws_iam_role_policy_attachment.efs_csi_driver,
    aws_iam_openid_connect_provider.cluster
  ]
}

# -----------------------------------------------------------------------------
# OIDC Provider (for IAM Roles for Service Accounts)
# -----------------------------------------------------------------------------
data "tls_certificate" "cluster" {
  url = aws_eks_cluster.main.identity[0].oidc[0].issuer
}

resource "aws_iam_openid_connect_provider" "cluster" {
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.cluster.certificates[0].sha1_fingerprint]
  url             = aws_eks_cluster.main.identity[0].oidc[0].issuer

  tags = var.tags
}

# -----------------------------------------------------------------------------
# EKS Access Entries (IAM to Kubernetes RBAC mapping via EKS API)
# This is the modern approach (EKS 1.24+) replacing aws-auth ConfigMap
# -----------------------------------------------------------------------------
resource "aws_eks_access_entry" "admin_roles" {
  for_each = toset(var.admin_role_arns)

  cluster_name  = aws_eks_cluster.main.name
  principal_arn = each.value
  type          = "STANDARD"

  depends_on = [aws_eks_cluster.main]
}

resource "aws_eks_access_policy_association" "admin_roles" {
  for_each = toset(var.admin_role_arns)

  cluster_name  = aws_eks_cluster.main.name
  principal_arn = each.value
  policy_arn    = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy"

  access_scope {
    type = "cluster"
  }

  depends_on = [aws_eks_access_entry.admin_roles]
}

# -----------------------------------------------------------------------------
# Outputs
# -----------------------------------------------------------------------------
output "cluster_name" {
  description = "EKS cluster name"
  value       = aws_eks_cluster.main.name
}

output "cluster_arn" {
  description = "EKS cluster ARN"
  value       = aws_eks_cluster.main.arn
}

output "cluster_endpoint" {
  description = "EKS cluster endpoint"
  value       = aws_eks_cluster.main.endpoint
}

output "cluster_certificate_authority_data" {
  description = "EKS cluster CA certificate"
  value       = aws_eks_cluster.main.certificate_authority[0].data
}

output "cluster_security_group_id" {
  description = "EKS cluster security group ID"
  value       = aws_security_group.cluster.id
}

output "node_security_group_id" {
  description = "EKS node security group ID"
  value       = aws_security_group.node.id
}

output "eks_managed_security_group_id" {
  description = "EKS-managed cluster security group ID (auto-created by EKS)"
  value       = aws_eks_cluster.main.vpc_config[0].cluster_security_group_id
}

output "oidc_provider_arn" {
  description = "OIDC provider ARN"
  value       = aws_iam_openid_connect_provider.cluster.arn
}

output "oidc_provider_url" {
  description = "OIDC provider URL"
  value       = aws_iam_openid_connect_provider.cluster.url
}

output "ebs_csi_driver_role_arn" {
  description = "IAM role ARN for EBS CSI driver"
  value       = aws_iam_role.ebs_csi_driver.arn
}

output "efs_csi_driver_role_arn" {
  description = "IAM role ARN for EFS CSI driver"
  value       = aws_iam_role.efs_csi_driver.arn
}

output "node_role_name" {
  description = "IAM role name for EKS node group"
  value       = aws_iam_role.node_group.name
}

output "node_role_arn" {
  description = "IAM role ARN for EKS node group"
  value       = aws_iam_role.node_group.arn
}
