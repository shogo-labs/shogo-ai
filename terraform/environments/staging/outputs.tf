# =============================================================================
# Outputs - Staging Environment
# =============================================================================

output "vpc_id" {
  description = "VPC ID"
  value       = module.vpc.vpc_id
}

output "eks_cluster_name" {
  description = "EKS cluster name"
  value       = module.eks.cluster_name
}

output "eks_cluster_endpoint" {
  description = "EKS cluster endpoint"
  value       = module.eks.cluster_endpoint
  sensitive   = true
}

output "rds_endpoint" {
  description = "RDS PostgreSQL endpoint"
  value       = module.rds.endpoint
  sensitive   = true
}

output "redis_endpoint" {
  description = "ElastiCache Redis endpoint"
  value       = module.elasticache.endpoint
  sensitive   = true
}

output "kubeconfig_command" {
  description = "Command to configure kubectl"
  value       = "aws eks update-kubeconfig --region ${var.aws_region} --name ${module.eks.cluster_name}"
}

output "github_actions_role_arn" {
  description = "GitHub Actions IAM role ARN - uses shared production role"
  value       = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/shogo-github-actions"
}

output "namespaces" {
  description = "Kubernetes namespaces created"
  value = {
    system     = "shogo-staging-system"
    workspaces = "shogo-staging-workspaces"
  }
}

output "domains" {
  description = "Staging domain names"
  value = {
    api     = "api-staging.shogo.ai"
    studio  = "studio-staging.shogo.ai"
    mcp     = "mcp-staging.shogo.ai"
    preview = "*.staging.shogo.ai"  # preview--{projectId}.staging.shogo.ai
  }
}
