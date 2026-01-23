# =============================================================================
# Variables - Production Environment
# Updated: January 2026 - Latest package versions
# =============================================================================

variable "aws_region" {
  description = "AWS region for deployment"
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Environment name"
  type        = string
  default     = "production"
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
  default     = "10.0.0.0/16"
}

# -----------------------------------------------------------------------------
# EKS Configuration
# -----------------------------------------------------------------------------
variable "eks_cluster_version" {
  description = "Kubernetes version for EKS cluster (latest stable: 1.33)"
  type        = string
  default     = "1.33" # Latest EKS supported version as of Jan 2026
}

variable "node_instance_types" {
  description = "Instance types for EKS node group"
  type        = list(string)
  default     = ["t3.medium", "t3.large"]
}

variable "node_desired_size" {
  description = "Desired number of nodes in the node group"
  type        = number
  default     = 2
}

variable "node_min_size" {
  description = "Minimum number of nodes in the node group"
  type        = number
  default     = 1
}

variable "node_max_size" {
  description = "Maximum number of nodes in the node group"
  type        = number
  default     = 10
}

# -----------------------------------------------------------------------------
# RDS Configuration
# -----------------------------------------------------------------------------
variable "rds_instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.t3.small"
}

variable "rds_allocated_storage" {
  description = "Allocated storage for RDS in GB"
  type        = number
  default     = 20
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
  description = "Knative Serving version (latest stable: 1.20)"
  type        = string
  default     = "1.20.0" # Latest Knative version as of Jan 2026
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
# Project Runtime Configuration (Per-Project PostgreSQL Sidecar)
# -----------------------------------------------------------------------------
variable "project_runtime_postgres_enabled" {
  description = "Enable PostgreSQL sidecar for project runtimes"
  type        = bool
  default     = true
}

variable "project_runtime_postgres_image" {
  description = "PostgreSQL image for project runtime sidecar"
  type        = string
  default     = "postgres:16-alpine"
}

variable "project_runtime_postgres_storage_size" {
  description = "Storage size for PostgreSQL data PVC per project"
  type        = string
  default     = "1Gi"
}

variable "project_runtime_postgres_memory_limit" {
  description = "Memory limit for PostgreSQL sidecar container"
  type        = string
  default     = "512Mi"
}

variable "project_runtime_postgres_cpu_limit" {
  description = "CPU limit for PostgreSQL sidecar container"
  type        = string
  default     = "250m"
}

variable "project_runtime_idle_timeout" {
  description = "Idle timeout in seconds before project pods scale to zero"
  type        = number
  default     = 300
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
