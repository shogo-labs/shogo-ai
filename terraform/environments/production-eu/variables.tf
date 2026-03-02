# =============================================================================
# Variables - Production EU Environment (eu-west-1)
# Multi-region secondary cluster
# =============================================================================

variable "bootstrap_mode" {
  description = "Set to true for initial deployment when EKS cluster doesn't exist yet. Set to false after cluster is created."
  type        = bool
  default     = false
}

variable "aws_region" {
  description = "AWS region for deployment"
  type        = string
  default     = "eu-west-1"
}

variable "primary_region" {
  description = "Primary region for cross-region resources (ECR replication source, DB primary)"
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Environment name"
  type        = string
  default     = "production"
}

variable "environment_suffix" {
  description = "Suffix to distinguish this region's resources"
  type        = string
  default     = "eu"
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
  description = "CIDR block for VPC (must not overlap with primary region)"
  type        = string
  default     = "10.1.0.0/16"
}

# -----------------------------------------------------------------------------
# EKS Configuration
# -----------------------------------------------------------------------------
variable "eks_cluster_version" {
  description = "Kubernetes version for EKS cluster"
  type        = string
  default     = "1.33"
}

variable "node_instance_types" {
  description = "Instance types for EKS node group"
  type        = list(string)
  default     = ["t3.xlarge"]
}

variable "node_desired_size" {
  description = "Desired number of nodes in the node group"
  type        = number
  default     = 1
}

variable "node_min_size" {
  description = "Minimum number of nodes in the node group"
  type        = number
  default     = 1
}

variable "node_max_size" {
  description = "Maximum number of nodes in the node group"
  type        = number
  default     = 15
}

variable "enable_secondary_node_group" {
  description = "Enable secondary node group for additional capacity"
  type        = bool
  default     = false
}

# -----------------------------------------------------------------------------
# CloudNativePG Configuration
# -----------------------------------------------------------------------------
variable "cnpg_s3_access_key_id" {
  description = "AWS Access Key ID for CloudNativePG S3 backups"
  type        = string
  default     = ""
  sensitive   = true
}

variable "cnpg_s3_secret_access_key" {
  description = "AWS Secret Access Key for CloudNativePG S3 backups"
  type        = string
  default     = ""
  sensitive   = true
}

variable "primary_pg_host" {
  description = "Primary region PostgreSQL host for cross-region replication (NLB or public endpoint)"
  type        = string
  default     = ""
}

# -----------------------------------------------------------------------------
# ElastiCache Configuration
# -----------------------------------------------------------------------------
variable "redis_node_type" {
  description = "ElastiCache Redis node type (Global Datastore requires m5.large minimum)"
  type        = string
  default     = "cache.m5.large"
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
  default     = ""
}

variable "anthropic_api_key" {
  description = "Anthropic API key for Claude Code integration"
  type        = string
  sensitive   = true
  default     = ""
}

variable "google_client_id" {
  description = "Google OAuth Client ID for social sign-in"
  type        = string
  default     = ""
}

variable "google_client_secret" {
  description = "Google OAuth Client Secret for social sign-in"
  type        = string
  sensitive   = true
  default     = ""
}

variable "composio_api_key" {
  description = "Composio API key for third-party integrations"
  type        = string
  sensitive   = true
  default     = ""
}

variable "composio_project_id" {
  description = "Composio Project ID"
  type        = string
  default     = ""
}

variable "gh_app_client_id" {
  description = "GitHub App OAuth Client ID"
  type        = string
  default     = ""
}

variable "gh_app_client_secret" {
  description = "GitHub App OAuth Client Secret"
  type        = string
  sensitive   = true
  default     = ""
}

variable "gh_app_id" {
  description = "GitHub App ID"
  type        = string
  default     = ""
}

variable "gh_app_private_key" {
  description = "GitHub App RSA private key (PEM format)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "gh_app_slug" {
  description = "GitHub App slug"
  type        = string
  default     = ""
}

variable "gh_app_webhook_secret" {
  description = "GitHub App webhook secret"
  type        = string
  sensitive   = true
  default     = ""
}

variable "stripe_secret_key" {
  description = "Stripe secret API key"
  type        = string
  sensitive   = true
  default     = ""
}

variable "stripe_webhook_secret" {
  description = "Stripe webhook signing secret"
  type        = string
  sensitive   = true
  default     = ""
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

# -----------------------------------------------------------------------------
# Observability Configuration
# -----------------------------------------------------------------------------
variable "enable_signoz" {
  description = "Enable SigNoz K8s infrastructure monitoring"
  type        = bool
  default     = false
}

variable "signoz_endpoint" {
  description = "SigNoz OTLP endpoint (gRPC)"
  type        = string
  default     = ""
}

variable "signoz_ingestion_key" {
  description = "SigNoz Cloud ingestion key"
  type        = string
  default     = ""
  sensitive   = true
}
