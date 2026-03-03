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
  description = "RDS PostgreSQL endpoint (LEGACY - during migration)"
  value       = module.rds.endpoint
  sensitive   = true
}

output "cnpg_platform_cluster" {
  description = "CloudNativePG platform cluster name"
  value       = "platform-pg"
}

output "cnpg_projects_cluster" {
  description = "CloudNativePG projects cluster name"
  value       = "projects-pg"
}

output "cnpg_platform_service" {
  description = "CloudNativePG platform database K8s service"
  value       = "platform-pg-rw.shogo-staging-system.svc.cluster.local"
}

output "cnpg_projects_service" {
  description = "CloudNativePG projects database K8s service"
  value       = "projects-pg-rw.shogo-staging-system.svc.cluster.local"
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
    preview = "*.staging.shogo.ai" # preview--{projectId}.staging.shogo.ai
  }
}

# -----------------------------------------------------------------------------
# Observability Outputs
# -----------------------------------------------------------------------------
output "signoz_enabled" {
  description = "Whether SigNoz monitoring is enabled"
  value       = !var.bootstrap_mode && var.enable_signoz && var.signoz_endpoint != ""
}

output "signoz_namespace" {
  description = "Namespace where SigNoz K8s Infra is deployed"
  value       = !var.bootstrap_mode && var.enable_signoz && var.signoz_endpoint != "" ? module.signoz[0].namespace : null
}

output "signoz_chart_version" {
  description = "Version of SigNoz K8s Infra chart deployed"
  value       = !var.bootstrap_mode && var.enable_signoz && var.signoz_endpoint != "" ? module.signoz[0].chart_version : null
}

locals {
  signoz_commands = <<-EOT
# Check DaemonSet (should have 1 pod per node)
kubectl get daemonset -n ${var.signoz_namespace}

# Check Deployment
kubectl get deployment -n ${var.signoz_namespace}

# Check logs
kubectl logs -n ${var.signoz_namespace} -l app.kubernetes.io/name=k8s-infra --tail=50

# Verify metrics are being sent
kubectl logs -n ${var.signoz_namespace} -l app.kubernetes.io/name=k8s-infra | grep "Exporting"
EOT
}

output "signoz_verification_commands" {
  description = "Commands to verify SigNoz deployment"
  value       = !var.bootstrap_mode && var.enable_signoz && var.signoz_endpoint != "" ? local.signoz_commands : "SigNoz not enabled (bootstrap_mode or missing config)"
}
