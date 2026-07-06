# =============================================================================
# Remote state scaffold (Phase 2a hardening)
# =============================================================================
# State is LOCAL today (terraform.tfstate in this dir). Before the fleet grows
# past the pilot, graduate to a shared remote backend so concurrent applies are
# safe and the state isn't trapped on one laptop.
#
# The runtime images already live in OCI Object Storage (S3-compatible), so the
# path of least resistance is an S3 backend pointed at an OCIR/Object-Storage
# bucket via a pre-authenticated/customer-secret-key endpoint. Because backend
# blocks can't use variables, initialize with partial config:
#
#   terraform init \
#     -backend-config="bucket=shogo-tfstate" \
#     -backend-config="key=latitude-metal/terraform.tfstate" \
#     -backend-config="region=us-ashburn-1" \
#     -backend-config="endpoints={s3=\"https://<namespace>.compat.objectstorage.us-ashburn-1.oraclecloud.com\"}" \
#     -backend-config="access_key=..." -backend-config="secret_key=..."
#
# OCI Object Storage S3 compatibility requires these skip flags (it is not AWS).
#
# terraform {
#   backend "s3" {
#     skip_region_validation      = true
#     skip_credentials_validation = true
#     skip_requesting_account_id  = true
#     skip_metadata_api_check     = true
#     skip_s3_checksum            = true
#     use_path_style              = true
#   }
# }
