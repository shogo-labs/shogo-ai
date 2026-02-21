# =============================================================================
# EFS Module - Elastic File System for Kubernetes
# =============================================================================
# Creates an EFS filesystem with mount targets in each subnet.
# Used for shared storage that supports multi-attach (unlike EBS).
# 
# Key use case: PostgreSQL data for project sidecars
# EFS allows multiple pods to access the same volume without Multi-Attach errors.
# =============================================================================

variable "name" {
  description = "Name prefix for EFS resources"
  type        = string
}

variable "vpc_id" {
  description = "VPC ID where EFS will be deployed"
  type        = string
}

variable "subnet_ids" {
  description = "List of subnet IDs for mount targets"
  type        = list(string)
}

variable "security_group_ids" {
  description = "List of security group IDs that can access EFS"
  type        = list(string)
}

variable "performance_mode" {
  description = "EFS performance mode: generalPurpose or maxIO"
  type        = string
  default     = "generalPurpose"
}

variable "throughput_mode" {
  description = "EFS throughput mode: bursting, provisioned, or elastic"
  type        = string
  default     = "elastic" # Best for variable workloads like project DBs
}

variable "encrypted" {
  description = "Enable encryption at rest"
  type        = bool
  default     = true
}

variable "tags" {
  description = "Additional tags for EFS resources"
  type        = map(string)
  default     = {}
}

# -----------------------------------------------------------------------------
# Security Group for EFS
# -----------------------------------------------------------------------------
resource "aws_security_group" "efs" {
  name_prefix = "${var.name}-efs-"
  description = "Security group for EFS mount targets"
  vpc_id      = var.vpc_id

  # Allow NFS traffic from specified security groups
  ingress {
    description     = "NFS from EKS"
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = var.security_group_ids
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, {
    Name = "${var.name}-efs"
  })

  lifecycle {
    create_before_destroy = true
  }
}

# -----------------------------------------------------------------------------
# EFS Filesystem
# -----------------------------------------------------------------------------
resource "aws_efs_file_system" "main" {
  creation_token = var.name
  encrypted      = var.encrypted

  performance_mode = var.performance_mode
  throughput_mode  = var.throughput_mode

  # Lifecycle policy - transition to IA after 30 days of no access
  lifecycle_policy {
    transition_to_ia = "AFTER_30_DAYS"
  }

  # Transition back to Standard on access
  lifecycle_policy {
    transition_to_primary_storage_class = "AFTER_1_ACCESS"
  }

  tags = merge(var.tags, {
    Name = var.name
  })
}

# -----------------------------------------------------------------------------
# EFS Mount Targets (one per subnet)
# -----------------------------------------------------------------------------
resource "aws_efs_mount_target" "main" {
  for_each = toset(var.subnet_ids)

  file_system_id  = aws_efs_file_system.main.id
  subnet_id       = each.value
  security_groups = [aws_security_group.efs.id]
}

# -----------------------------------------------------------------------------
# Outputs
# -----------------------------------------------------------------------------
output "file_system_id" {
  description = "EFS filesystem ID"
  value       = aws_efs_file_system.main.id
}

output "file_system_arn" {
  description = "EFS filesystem ARN"
  value       = aws_efs_file_system.main.arn
}

output "dns_name" {
  description = "EFS DNS name"
  value       = aws_efs_file_system.main.dns_name
}

output "security_group_id" {
  description = "Security group ID for EFS"
  value       = aws_security_group.efs.id
}

output "mount_target_ids" {
  description = "Map of subnet ID to mount target ID"
  value       = { for k, v in aws_efs_mount_target.main : k => v.id }
}
