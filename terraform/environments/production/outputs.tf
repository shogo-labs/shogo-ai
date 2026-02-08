# =============================================================================
# Outputs - Production Environment
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

output "ecr_repository_urls" {
  description = "ECR repository URLs"
  value       = module.ecr.repository_urls
}

output "cnpg_platform_service" {
  description = "CloudNativePG platform database K8s service"
  value       = "platform-pg-rw.shogo-system.svc.cluster.local"
}

output "cnpg_projects_service" {
  description = "CloudNativePG projects database K8s service"
  value       = "projects-pg-rw.shogo-system.svc.cluster.local"
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

output "deploy_command" {
  description = "Command to deploy the application"
  value       = "cd ${path.module}/../../../ && ./scripts/deploy-eks.sh"
}


output "github_actions_role_arn" {
  description = "GitHub Actions IAM role ARN (use this in GitHub secrets as AWS_ROLE_ARN)"
  value       = module.github_oidc.role_arn
}
