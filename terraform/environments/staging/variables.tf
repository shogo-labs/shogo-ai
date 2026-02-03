# =============================================================================
# Variables - Staging Environment
# Updated: January 2026
# =============================================================================

variable "bootstrap_mode" {
  description = "Set to true for initial deployment when EKS cluster doesn't exist yet. Set to false after cluster is created."
  type        = bool
  default     = false
}

variable "aws_region" {
  description = "AWS region for deployment"
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Environment name"
  type        = string
  default     = "staging"
}

variable "project_name" {
  description = "Project name used for resource naming"
  type        = string
  default     = "shogo"
}

# -----------------------------------------------------------------------------
# VPC Configuration
# -----------------------------------------------------------------------------
variable "vpc_cidr" {
  description = "CIDR block for VPC"
  type        = string
  default     = "10.1.0.0/16" # Different from production (10.0.0.0/16)
}

# -----------------------------------------------------------------------------
# EKS Configuration
# -----------------------------------------------------------------------------
variable "eks_cluster_version" {
  description = "Kubernetes version for EKS cluster (latest stable: 1.33)"
  type        = string
  default     = "1.33"
}

variable "node_instance_types" {
  description = "Instance types for EKS node group"
  type        = list(string)
  default     = ["t3.medium"] # Smaller than production
}

variable "node_desired_size" {
  description = "Desired number of nodes in the node group"
  type        = number
  default     = 2 # t3.small has 11 pod limit, need 2 nodes for system + app pods
}

variable "node_min_size" {
  description = "Minimum number of nodes in the node group"
  type        = number
  default     = 2 # Minimum 2 to avoid pod scheduling issues
}

variable "node_max_size" {
  description = "Maximum number of nodes in the node group"
  type        = number
  default     = 5 # Smaller than production
}

# -----------------------------------------------------------------------------
# RDS Configuration
# -----------------------------------------------------------------------------
variable "rds_instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.t3.micro" # Smaller than production
}

variable "rds_allocated_storage" {
  description = "Allocated storage for RDS in GB"
  type        = number
  default     = 20
}

variable "rds_backup_retention_period" {
  description = "RDS backup retention period in days (0 for Free Tier accounts)"
  type        = number
  default     = 0
}

# -----------------------------------------------------------------------------
# ElastiCache Configuration
# -----------------------------------------------------------------------------
variable "redis_node_type" {
  description = "ElastiCache Redis node type"
  type        = string
  default     = "cache.t3.micro"
}

# -----------------------------------------------------------------------------
# Knative Configuration
# -----------------------------------------------------------------------------
variable "knative_version" {
  description = "Knative Serving version"
  type        = string
  default     = "1.20.0"
}

variable "domain" {
  description = "Primary domain for Knative services (e.g., shogo.ai)"
  type        = string
  default     = ""
}

variable "publish_domain" {
  description = "Domain for published apps (e.g., shogo.one)"
  type        = string
  default     = ""
}

variable "ssl_certificate_domain" {
  description = "Domain name to look up ACM certificate for platform (e.g., *.shogo.ai)"
  type        = string
  default     = ""
}

variable "ssl_certificate_domain_publish" {
  description = "Domain name to look up ACM certificate for published apps (e.g., *.shogo.one)"
  type        = string
  default     = ""
}

# -----------------------------------------------------------------------------
# Application Configuration
# -----------------------------------------------------------------------------
variable "better_auth_secret" {
  description = "Secret key for BetterAuth (min 32 characters)"
  type        = string
  sensitive   = true
}

variable "anthropic_api_key" {
  description = "Anthropic API key for Claude Code integration"
  type        = string
  sensitive   = true
  default     = ""  # Optional - can be managed by GitHub Actions instead
}

# -----------------------------------------------------------------------------
# GitHub Actions CI/CD Configuration
# -----------------------------------------------------------------------------
variable "github_org" {
  description = "GitHub organization or username"
  type        = string
  default     = ""
}

variable "github_repo" {
  description = "GitHub repository name"
  type        = string
  default     = "shogo-ai"
}

# -----------------------------------------------------------------------------
# Observability Configuration (SigNoz)
# -----------------------------------------------------------------------------
variable "enable_signoz" {
  description = "Enable SigNoz K8s infrastructure monitoring"
  type        = bool
  default     = true
}

variable "signoz_endpoint" {
  description = "SigNoz OTLP endpoint (gRPC) - e.g., http://signoz-otel-collector.signoz.svc.cluster.local:4317 or ingest.us.signoz.cloud:443"
  type        = string
  default     = ""
}

variable "signoz_ingestion_key" {
  description = "SigNoz Cloud ingestion key (required for SigNoz Cloud, leave empty for self-hosted)"
  type        = string
  default     = ""
  sensitive   = true
}

variable "signoz_namespace" {
  description = "Namespace for SigNoz K8s Infra components"
  type        = string
  default     = "signoz"
}

variable "signoz_enable_logs" {
  description = "Enable log collection in SigNoz"
  type        = bool
  default     = false
}

variable "signoz_enable_events" {
  description = "Enable Kubernetes event collection in SigNoz"
  type        = bool
  default     = true
}

variable "signoz_enable_metrics" {
  description = "Enable metrics collection in SigNoz"
  type        = bool
  default     = true
}
