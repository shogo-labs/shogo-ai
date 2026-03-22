# =============================================================================
# DRG Peering Module
# =============================================================================
# Creates a Dynamic Routing Gateway (DRG) attached to a VCN and optionally
# establishes a Remote Peering Connection (RPC) to another region's DRG.
#
# For cross-region peering, both sides create a DRG + RPC. One side acts as
# the "requestor" and provides its RPC OCID to the other side (the "acceptor").
#
# Usage (hub-spoke or mesh):
#
#   # Region A (requestor)
#   module "drg_us" {
#     source         = "../../modules/drg-peering"
#     name           = "shogo-production-us"
#     compartment_id = var.compartment_id
#     vcn_id         = module.us.vcn_id
#     peer_region    = "eu-frankfurt-1"
#   }
#
#   # Region B (acceptor) — pass the requestor's RPC OCID
#   module "drg_eu" {
#     source         = "../../modules/drg-peering"
#     name           = "shogo-production-eu"
#     compartment_id = var.compartment_id
#     vcn_id         = module.eu.vcn_id
#     peer_region    = "us-ashburn-1"
#     peer_rpc_id    = module.drg_us.rpc_id  # connects the two RPCs
#   }
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
  description = "Name prefix for DRG resources"
  type        = string
}

variable "compartment_id" {
  description = "OCI compartment OCID"
  type        = string
}

variable "vcn_id" {
  description = "VCN OCID to attach the DRG to"
  type        = string
}

variable "peer_region" {
  description = "Remote region name (for display purposes and RPC naming)"
  type        = string
}

variable "peer_rpc_id" {
  description = "Remote Peering Connection OCID of the peer to connect to. Leave empty if this side is the requestor (the acceptor will reference this module's rpc_id)."
  type        = string
  default     = ""
}

variable "vcn_route_cidrs" {
  description = "List of remote VCN CIDRs to add as route rules through the DRG"
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Freeform tags"
  type        = map(string)
  default     = {}
}

# -----------------------------------------------------------------------------
# Dynamic Routing Gateway
# -----------------------------------------------------------------------------

resource "oci_core_drg" "main" {
  compartment_id = var.compartment_id
  display_name   = "${var.name}-drg"
  freeform_tags  = var.tags
}

resource "oci_core_drg_attachment" "vcn" {
  drg_id       = oci_core_drg.main.id
  display_name = "${var.name}-drg-vcn"

  network_details {
    id   = var.vcn_id
    type = "VCN"
  }
}

# -----------------------------------------------------------------------------
# Remote Peering Connection
# -----------------------------------------------------------------------------

resource "oci_core_remote_peering_connection" "main" {
  compartment_id = var.compartment_id
  drg_id         = oci_core_drg.main.id
  display_name   = "${var.name}-rpc-to-${var.peer_region}"
  peer_id        = var.peer_rpc_id != "" ? var.peer_rpc_id : null
  peer_region_name = var.peer_rpc_id != "" ? var.peer_region : null
  freeform_tags  = var.tags
}

# -----------------------------------------------------------------------------
# Outputs
# -----------------------------------------------------------------------------

output "drg_id" {
  description = "DRG OCID"
  value       = oci_core_drg.main.id
}

output "drg_attachment_id" {
  description = "DRG-to-VCN attachment OCID"
  value       = oci_core_drg_attachment.vcn.id
}

output "rpc_id" {
  description = "Remote Peering Connection OCID — pass this to the peer region module"
  value       = oci_core_remote_peering_connection.main.id
}

output "rpc_peering_status" {
  description = "RPC peering status (PEERED, PENDING, etc.)"
  value       = oci_core_remote_peering_connection.main.peering_status
}
