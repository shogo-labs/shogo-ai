# =============================================================================
# Publish Hosting Module - S3 + CloudFront for Published Apps
# =============================================================================
# This module creates the infrastructure for serving published static apps:
#   - S3 bucket for static content (per-subdomain structure)
#   - CloudFront distribution with wildcard domain (*.shogo.one)
#   - Origin Access Control for secure S3 access
#
# Published apps are stored at: s3://bucket/{subdomain}/
# Served at: https://{subdomain}.shogo.one
# =============================================================================

# -----------------------------------------------------------------------------
# Variables
# -----------------------------------------------------------------------------
variable "environment" {
  description = "Environment name (staging, production)"
  type        = string
}

variable "publish_domain" {
  description = "Base domain for published apps (e.g., shogo.one)"
  type        = string
  default     = "shogo.one"
}

variable "acm_certificate_arn" {
  description = "ARN of ACM certificate for *.{publish_domain}"
  type        = string
}

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}

# -----------------------------------------------------------------------------
# S3 Bucket for Published Apps
# -----------------------------------------------------------------------------
resource "aws_s3_bucket" "published_apps" {
  bucket = "shogo-published-apps-${var.environment}"

  tags = merge(var.tags, {
    Name    = "shogo-published-apps-${var.environment}"
    Purpose = "published-static-sites"
  })
}

# Disable ACLs - use bucket policies instead
resource "aws_s3_bucket_ownership_controls" "published_apps" {
  bucket = aws_s3_bucket.published_apps.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Block all public access - CloudFront uses OAC
resource "aws_s3_bucket_public_access_block" "published_apps" {
  bucket = aws_s3_bucket.published_apps.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Enable versioning for rollback capability
resource "aws_s3_bucket_versioning" "published_apps" {
  bucket = aws_s3_bucket.published_apps.id

  versioning_configuration {
    status = "Enabled"
  }
}

# Server-side encryption
resource "aws_s3_bucket_server_side_encryption_configuration" "published_apps" {
  bucket = aws_s3_bucket.published_apps.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Lifecycle rule - clean up old versions
resource "aws_s3_bucket_lifecycle_configuration" "published_apps" {
  bucket = aws_s3_bucket.published_apps.id

  rule {
    id     = "cleanup-old-versions"
    status = "Enabled"

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}

# CORS configuration for API calls from published apps
resource "aws_s3_bucket_cors_configuration" "published_apps" {
  bucket = aws_s3_bucket.published_apps.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "HEAD"]
    allowed_origins = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3600
  }
}

# -----------------------------------------------------------------------------
# CloudFront Origin Access Control
# -----------------------------------------------------------------------------
resource "aws_cloudfront_origin_access_control" "published_apps" {
  name                              = "shogo-published-apps-${var.environment}"
  description                       = "OAC for published apps S3 bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# -----------------------------------------------------------------------------
# CloudFront Distribution
# -----------------------------------------------------------------------------
resource "aws_cloudfront_distribution" "published_apps" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "Shogo published apps - ${var.environment}"
  default_root_object = "index.html"
  price_class         = "PriceClass_100" # US, Canada, Europe only (cheaper)

  # Wildcard domain for all published apps
  aliases = ["*.${var.publish_domain}"]

  origin {
    domain_name              = aws_s3_bucket.published_apps.bucket_regional_domain_name
    origin_id                = "S3-published-apps"
    origin_access_control_id = aws_cloudfront_origin_access_control.published_apps.id
  }

  default_cache_behavior {
    allowed_methods  = ["GET", "HEAD", "OPTIONS"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "S3-published-apps"

    # Use managed cache policy (CachingOptimized)
    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"

    # Use managed origin request policy (CORS-S3Origin)
    origin_request_policy_id = "88a5eaf4-2fd4-4709-b370-b4c650ea3fcf"

    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    # CloudFront function to rewrite requests based on subdomain
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.subdomain_router.arn
    }
  }

  # Custom error responses for SPA routing
  custom_error_response {
    error_code         = 403
    response_code      = 200
    response_page_path = "/index.html"
  }

  custom_error_response {
    error_code         = 404
    response_code      = 200
    response_page_path = "/index.html"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = var.acm_certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = merge(var.tags, {
    Name = "shogo-published-apps-${var.environment}"
  })
}

# -----------------------------------------------------------------------------
# CloudFront Function - Subdomain Router
# -----------------------------------------------------------------------------
# This function rewrites requests based on the subdomain:
#   https://hello-world.shogo.one/index.html → S3: /hello-world/index.html
# -----------------------------------------------------------------------------
resource "aws_cloudfront_function" "subdomain_router" {
  name    = "shogo-subdomain-router-${var.environment}"
  runtime = "cloudfront-js-2.0"
  comment = "Routes requests to subdomain-specific folders in S3"
  publish = true

  code = <<-EOF
    function handler(event) {
      var request = event.request;
      var host = request.headers.host.value;
      
      // Extract subdomain from host (e.g., "hello-world" from "hello-world.shogo.one")
      var subdomain = host.split('.')[0];
      
      // Prepend subdomain to the URI path
      // /index.html → /hello-world/index.html
      var originalUri = request.uri;
      
      // Handle root path
      if (originalUri === '/' || originalUri === '') {
        request.uri = '/' + subdomain + '/index.html';
      } else {
        request.uri = '/' + subdomain + originalUri;
      }
      
      return request;
    }
  EOF
}

# -----------------------------------------------------------------------------
# S3 Bucket Policy - Allow CloudFront Access
# -----------------------------------------------------------------------------
resource "aws_s3_bucket_policy" "published_apps" {
  bucket = aws_s3_bucket.published_apps.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowCloudFrontServicePrincipal"
        Effect = "Allow"
        Principal = {
          Service = "cloudfront.amazonaws.com"
        }
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.published_apps.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.published_apps.arn
          }
        }
      }
    ]
  })
}

# -----------------------------------------------------------------------------
# Route53 Record (if hosted zone exists and is managed here)
# -----------------------------------------------------------------------------
# Note: This requires the hosted zone to be managed in the same AWS account
# If DNS is managed elsewhere, create this record manually:
#   *.shogo.one CNAME → {cloudfront_distribution_domain_name}

variable "create_route53_record" {
  description = "Whether to create Route53 record (requires hosted zone in same account)"
  type        = bool
  default     = false
}

data "aws_route53_zone" "publish_domain" {
  count        = var.create_route53_record ? 1 : 0
  name         = "${var.publish_domain}."
  private_zone = false
}

resource "aws_route53_record" "wildcard" {
  count   = var.create_route53_record ? 1 : 0
  zone_id = data.aws_route53_zone.publish_domain[0].zone_id
  name    = "*.${var.publish_domain}"
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.published_apps.domain_name
    zone_id                = aws_cloudfront_distribution.published_apps.hosted_zone_id
    evaluate_target_health = false
  }
}

# -----------------------------------------------------------------------------
# Outputs
# -----------------------------------------------------------------------------
output "bucket_name" {
  description = "Name of the S3 bucket for published apps"
  value       = aws_s3_bucket.published_apps.id
}

output "bucket_arn" {
  description = "ARN of the S3 bucket"
  value       = aws_s3_bucket.published_apps.arn
}

output "bucket_regional_domain_name" {
  description = "Regional domain name of the S3 bucket"
  value       = aws_s3_bucket.published_apps.bucket_regional_domain_name
}

output "cloudfront_distribution_id" {
  description = "ID of the CloudFront distribution"
  value       = aws_cloudfront_distribution.published_apps.id
}

output "cloudfront_distribution_arn" {
  description = "ARN of the CloudFront distribution"
  value       = aws_cloudfront_distribution.published_apps.arn
}

output "cloudfront_domain_name" {
  description = "Domain name of the CloudFront distribution"
  value       = aws_cloudfront_distribution.published_apps.domain_name
}

output "publish_domain" {
  description = "Base domain for published apps"
  value       = var.publish_domain
}
