# =============================================================================
# File Storage Module (OCI)
# =============================================================================
# Creates an OCI File Storage Service filesystem with mount targets.
# Used for shared NFS storage (multi-attach) — equivalent to AWS EFS.
# =============================================================================

terraform {
  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 6.0"
    }
  }
}

variable "name" {
  description = "Name prefix for FSS resources"
  type        = string
}

variable "compartment_id" {
  description = "OCI compartment OCID"
  type        = string
}

variable "availability_domain" {
  description = "Availability domain for the file system and mount target"
  type        = string
}

variable "subnet_id" {
  description = "Subnet OCID for the mount target"
  type        = string
}

variable "nsg_ids" {
  description = "NSG OCIDs to attach to the mount target"
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Freeform tags"
  type        = map(string)
  default     = {}
}

# -----------------------------------------------------------------------------
# File System
# -----------------------------------------------------------------------------
resource "oci_file_storage_file_system" "main" {
  compartment_id      = var.compartment_id
  availability_domain = var.availability_domain
  display_name        = var.name

  freeform_tags = var.tags
}

# -----------------------------------------------------------------------------
# Mount Target
# -----------------------------------------------------------------------------
resource "oci_file_storage_mount_target" "main" {
  compartment_id      = var.compartment_id
  availability_domain = var.availability_domain
  subnet_id           = var.subnet_id
  display_name        = "${var.name}-mount"
  nsg_ids             = var.nsg_ids

  freeform_tags = var.tags
}

# -----------------------------------------------------------------------------
# Export (makes the file system accessible via the mount target)
# -----------------------------------------------------------------------------
resource "oci_file_storage_export_set" "main" {
  mount_target_id  = oci_file_storage_mount_target.main.id
  display_name     = "${var.name}-export-set"
  max_fs_stat_bytes = 0 # unlimited
}

resource "oci_file_storage_export" "main" {
  export_set_id  = oci_file_storage_export_set.main.id
  file_system_id = oci_file_storage_file_system.main.id
  path           = "/${var.name}"

  export_options {
    source                         = "0.0.0.0/0"
    access                         = "READ_WRITE"
    identity_squash                = "NONE"
    require_privileged_source_port = false
  }
}

# -----------------------------------------------------------------------------
# Outputs
# -----------------------------------------------------------------------------
output "file_system_id" {
  description = "File system OCID"
  value       = oci_file_storage_file_system.main.id
}

output "mount_target_id" {
  description = "Mount target OCID"
  value       = oci_file_storage_mount_target.main.id
}

output "mount_target_private_ip_ids" {
  description = "Mount target private IP OCIDs (resolve via oci_core_private_ip data source)"
  value       = oci_file_storage_mount_target.main.private_ip_ids
}

output "export_path" {
  description = "NFS export path"
  value       = "/${var.name}"
}
