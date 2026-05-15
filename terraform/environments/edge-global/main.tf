# =============================================================================
# Shogo — Edge Global (Cloudflare-only)
# =============================================================================
# Cloudflare edge resources that don't belong to any single OCI region and
# don't share state with the regional LB topology in production-global.
# Currently:
#
#   install.shogo.ai     -> serves packages/shogo-worker/install.{sh,ps1}
#   releases.shogo.ai    -> resolves /cli/<channel>/shogo-<target>.<ext>(.sha256)?
#                           to the matching v* GitHub Release asset
#
# Kept separate from production-global so the install/releases Workers
# can be applied via the standard terraform.yml CI flow (S3 backend)
# without needing to first migrate production-global's existing local
# state (which already owns studio.shogo.ai / docs.shogo.ai / the tunnel
# A records) into OCI Object Storage.
# =============================================================================

terraform {
  required_version = ">= 1.5"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }

  # Remote state on OCI Object Storage (S3-compat), same bucket as the
  # OCI envs. Endpoint is supplied via -backend-config at init time:
  #   terraform init -backend-config="endpoint=$OCI_S3_ENDPOINT"
  # Credentials come from $AWS_ACCESS_KEY_ID / $AWS_SECRET_ACCESS_KEY
  # (GH secrets OCI_S3_ACCESS_KEY / OCI_S3_SECRET_KEY).
  backend "s3" {
    bucket = "shogo-tfstate"
    key    = "edge-global/terraform.tfstate"
    region = "us-ashburn-1"

    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    force_path_style            = true
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

module "install_shogo_ai" {
  source = "../../modules/install-shogo-ai"

  cloudflare_account_id = var.cloudflare_account_id
  cloudflare_zone_id    = var.cloudflare_zone_id
  domain                = "shogo.ai"
  github_token          = var.github_token
  environment           = "production"
}

output "install_url" { value = module.install_shogo_ai.install_url }
output "releases_url" { value = module.install_shogo_ai.releases_url }
