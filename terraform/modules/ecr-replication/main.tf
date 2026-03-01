# =============================================================================
# ECR Cross-Region Replication Module
# =============================================================================
# Configures ECR replication rules to automatically replicate images from
# the primary region to one or more secondary regions.
#
# NOTE: This is a registry-level setting applied once per AWS account.
# It replicates ALL repositories to the specified regions.
# =============================================================================

variable "replica_regions" {
  description = "List of AWS regions to replicate images to"
  type        = list(string)
}

data "aws_caller_identity" "current" {}

resource "aws_ecr_replication_configuration" "cross_region" {
  replication_configuration {
    rule {
      dynamic "destination" {
        for_each = var.replica_regions
        content {
          region      = destination.value
          registry_id = data.aws_caller_identity.current.account_id
        }
      }
    }
  }
}

output "registry_id" {
  description = "Registry ID (AWS account ID)"
  value       = data.aws_caller_identity.current.account_id
}
