# =============================================================================
# Schema Storage S3 Module
# =============================================================================
# Creates an S3 bucket for storing workspace schemas with:
# - Server-side encryption
# - Versioning for history
# - Lifecycle rules for old versions
# - IAM policy for EKS workload identity
# =============================================================================

variable "environment" {
  description = "Environment name (staging, production)"
  type        = string
}

variable "eks_oidc_provider_arn" {
  description = "EKS OIDC provider ARN for IRSA"
  type        = string
}

variable "eks_oidc_provider_url" {
  description = "EKS OIDC provider URL (without https://)"
  type        = string
}

variable "mcp_service_account_namespace" {
  description = "Kubernetes namespace for MCP service account"
  type        = string
  default     = "shogo-workspaces"
}

variable "mcp_service_account_name" {
  description = "Kubernetes service account name for MCP pods"
  type        = string
  default     = "mcp-sa"
}

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}

# -----------------------------------------------------------------------------
# S3 Bucket
# -----------------------------------------------------------------------------
resource "aws_s3_bucket" "schemas" {
  bucket = "shogo-schemas-${var.environment}"

  tags = merge(var.tags, {
    Name        = "shogo-schemas-${var.environment}"
    Environment = var.environment
    Purpose     = "workspace-schema-storage"
  })
}

# Enable versioning for schema history
resource "aws_s3_bucket_versioning" "schemas" {
  bucket = aws_s3_bucket.schemas.id

  versioning_configuration {
    status = "Enabled"
  }
}

# Server-side encryption
resource "aws_s3_bucket_server_side_encryption_configuration" "schemas" {
  bucket = aws_s3_bucket.schemas.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Block public access
resource "aws_s3_bucket_public_access_block" "schemas" {
  bucket = aws_s3_bucket.schemas.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Lifecycle rule: Move old versions to cheaper storage, delete after 90 days
resource "aws_s3_bucket_lifecycle_configuration" "schemas" {
  bucket = aws_s3_bucket.schemas.id

  rule {
    id     = "archive-old-versions"
    status = "Enabled"

    noncurrent_version_transition {
      noncurrent_days = 30
      storage_class   = "STANDARD_IA"
    }

    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}

# -----------------------------------------------------------------------------
# IAM Role for MCP pods (IRSA - IAM Roles for Service Accounts)
# -----------------------------------------------------------------------------
resource "aws_iam_role" "mcp_s3_access" {
  name = "shogo-mcp-s3-access-${var.environment}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Federated = var.eks_oidc_provider_arn
      }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "${var.eks_oidc_provider_url}:sub" = "system:serviceaccount:${var.mcp_service_account_namespace}:${var.mcp_service_account_name}"
          "${var.eks_oidc_provider_url}:aud" = "sts.amazonaws.com"
        }
      }
    }]
  })

  tags = var.tags
}

# S3 access policy for MCP pods
resource "aws_iam_role_policy" "mcp_s3_access" {
  name = "s3-schema-access"
  role = aws_iam_role.mcp_s3_access.id

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
          aws_s3_bucket.schemas.arn,
          "${aws_s3_bucket.schemas.arn}/*"
        ]
      }
    ]
  })
}

# -----------------------------------------------------------------------------
# Outputs
# -----------------------------------------------------------------------------
output "bucket_name" {
  description = "S3 bucket name for schema storage"
  value       = aws_s3_bucket.schemas.id
}

output "bucket_arn" {
  description = "S3 bucket ARN"
  value       = aws_s3_bucket.schemas.arn
}

output "mcp_role_arn" {
  description = "IAM role ARN for MCP pods to access S3"
  value       = aws_iam_role.mcp_s3_access.arn
}
