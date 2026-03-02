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

