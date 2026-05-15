# =============================================================================
# VCN Module (OCI)
# =============================================================================
# Creates a production-ready Virtual Cloud Network with public and private
# subnets, gateways, route tables, and network security groups.
# Equivalent to the AWS VPC module.
# =============================================================================

terraform {
  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 8.0"
    }
  }
}

variable "name" {
  description = "Name prefix for VCN resources"
  type        = string
}

variable "compartment_id" {
  description = "OCI compartment OCID"
  type        = string
}

variable "cidr" {
  description = "CIDR block for VCN"
  type        = string
  default     = "10.0.0.0/16"
}

variable "tags" {
  description = "Freeform tags to apply to resources"
  type        = map(string)
  default     = {}
}

variable "single_nat_gateway" {
  description = "Use single NAT gateway (cost savings for non-prod). OCI NAT gateways are regional, so this is always effectively true."
  type        = bool
  default     = true
}

variable "oke_api_allowed_cidrs" {
  description = "CIDRs allowed to reach the OKE API endpoint (port 6443). Restrict to VPN/bastion ranges."
  type        = list(string)
}

variable "enable_security_lists" {
  description = "Create module-owned security lists and attach them to the subnets. When false, subnets keep whatever security lists they were created with (typically the VCN's default), and rules-enforcement is expected to come from NSGs or downstream policy. Defaults to true; set false for environments that were bootstrapped against the default security list and don't want a network-rule rewrite during state reconciliation."
  type        = bool
  default     = true
}

variable "enable_oke_nsgs" {
  description = "Create the OKE API + worker network security groups (and their rules), and emit their OCIDs via `oke_api_nsg_id` / `oke_workers_nsg_id` outputs. When false, those outputs are null and the OKE module attaches no NSGs to the cluster endpoint or node pools. Defaults to true; set false for environments that were bootstrapped without NSGs and where rules-enforcement is intentionally handled by security lists or external firewalls."
  type        = bool
  default     = true
}

# OCI subnets can be regional (span all ADs) — no need to enumerate ADs
# for subnet placement. We create one public and one private regional subnet.

# -----------------------------------------------------------------------------
# VCN
# -----------------------------------------------------------------------------
resource "oci_core_vcn" "main" {
  compartment_id = var.compartment_id
  cidr_blocks    = [var.cidr]
  display_name   = var.name
  dns_label      = replace(substr(var.name, 0, 15), "-", "")

  freeform_tags = var.tags
}

# -----------------------------------------------------------------------------
# Internet Gateway (public subnet internet access)
# -----------------------------------------------------------------------------
resource "oci_core_internet_gateway" "main" {
  compartment_id = var.compartment_id
  vcn_id         = oci_core_vcn.main.id
  display_name   = "${var.name}-igw"
  enabled        = true

  freeform_tags = var.tags
}

# -----------------------------------------------------------------------------
# NAT Gateway (private subnet internet access)
# OCI NAT Gateways are regional — one per VCN is sufficient.
# -----------------------------------------------------------------------------
resource "oci_core_nat_gateway" "main" {
  compartment_id = var.compartment_id
  vcn_id         = oci_core_vcn.main.id
  display_name   = "${var.name}-nat"

  freeform_tags = var.tags
}

# -----------------------------------------------------------------------------
# Service Gateway (access to OCI services without internet)
# Required for OKE nodes to pull images from OCIR, access Object Storage, etc.
# -----------------------------------------------------------------------------
data "oci_core_services" "all" {
  filter {
    name   = "name"
    values = ["All .* Services In Oracle Services Network"]
    regex  = true
  }
}

resource "oci_core_service_gateway" "main" {
  compartment_id = var.compartment_id
  vcn_id         = oci_core_vcn.main.id
  display_name   = "${var.name}-sgw"

  services {
    service_id = data.oci_core_services.all.services[0].id
  }

  freeform_tags = var.tags
}

# -----------------------------------------------------------------------------
# Route Tables
# -----------------------------------------------------------------------------
resource "oci_core_route_table" "public" {
  compartment_id = var.compartment_id
  vcn_id         = oci_core_vcn.main.id
  display_name   = "${var.name}-public-rt"

  route_rules {
    network_entity_id = oci_core_internet_gateway.main.id
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
  }

  freeform_tags = var.tags
}

resource "oci_core_route_table" "private" {
  compartment_id = var.compartment_id
  vcn_id         = oci_core_vcn.main.id
  display_name   = "${var.name}-private-rt"

  route_rules {
    network_entity_id = oci_core_nat_gateway.main.id
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
  }

  route_rules {
    network_entity_id = oci_core_service_gateway.main.id
    destination       = data.oci_core_services.all.services[0].cidr_block
    destination_type  = "SERVICE_CIDR_BLOCK"
  }

  freeform_tags = var.tags
}

# -----------------------------------------------------------------------------
# Security Lists
# -----------------------------------------------------------------------------
resource "oci_core_security_list" "public" {
  count = var.enable_security_lists ? 1 : 0

  compartment_id = var.compartment_id
  vcn_id         = oci_core_vcn.main.id
  display_name   = "${var.name}-public-sl"

  # Allow all egress
  egress_security_rules {
    protocol    = "all"
    destination = "0.0.0.0/0"
    stateless   = false
  }

  # Allow ICMP (path discovery)
  ingress_security_rules {
    protocol  = "1" # ICMP
    source    = "0.0.0.0/0"
    stateless = false
    icmp_options {
      type = 3
      code = 4
    }
  }

  # Allow HTTP/HTTPS from internet (for load balancers)
  ingress_security_rules {
    protocol  = "6" # TCP
    source    = "0.0.0.0/0"
    stateless = false
    tcp_options {
      min = 80
      max = 80
    }
  }

  ingress_security_rules {
    protocol  = "6"
    source    = "0.0.0.0/0"
    stateless = false
    tcp_options {
      min = 443
      max = 443
    }
  }

  freeform_tags = var.tags
}

resource "oci_core_security_list" "private" {
  count = var.enable_security_lists ? 1 : 0

  compartment_id = var.compartment_id
  vcn_id         = oci_core_vcn.main.id
  display_name   = "${var.name}-private-sl"

  # Allow all egress
  egress_security_rules {
    protocol    = "all"
    destination = "0.0.0.0/0"
    stateless   = false
  }

  # Allow all traffic within VCN
  ingress_security_rules {
    protocol  = "all"
    source    = var.cidr
    stateless = false
  }

  # Allow ICMP (path discovery)
  ingress_security_rules {
    protocol  = "1"
    source    = "0.0.0.0/0"
    stateless = false
    icmp_options {
      type = 3
      code = 4
    }
  }

  freeform_tags = var.tags
}

# -----------------------------------------------------------------------------
# Public Subnet (regional — spans all ADs)
# Used for: Load Balancers, OKE API endpoint (if public)
# -----------------------------------------------------------------------------
resource "oci_core_subnet" "public" {
  compartment_id             = var.compartment_id
  vcn_id                     = oci_core_vcn.main.id
  cidr_block                 = cidrsubnet(var.cidr, 4, 0)
  display_name               = "${var.name}-public"
  dns_label                  = "pub"
  prohibit_public_ip_on_vnic = false
  route_table_id             = oci_core_route_table.public.id

  # When module-owned security lists are disabled (`enable_security_lists =
  # false`), leave `security_list_ids` unmanaged so OCI keeps whatever was
  # attached at provisioning time (typically the VCN's default security
  # list). Specifying `null` here would clear all attachments, which can't
  # be done because OCI requires every subnet to have at least one.
  security_list_ids = var.enable_security_lists ? [oci_core_security_list.public[0].id] : null

  # See note on `oci_core_subnet.private_workers.lifecycle`.
  lifecycle {
    ignore_changes = [security_list_ids]
  }

  freeform_tags = var.tags
}

# -----------------------------------------------------------------------------
# Private Subnet — Workers (regional)
# Used for: OKE worker nodes
# -----------------------------------------------------------------------------
resource "oci_core_subnet" "private_workers" {
  compartment_id             = var.compartment_id
  vcn_id                     = oci_core_vcn.main.id
  cidr_block                 = cidrsubnet(var.cidr, 4, 1)
  display_name               = "${var.name}-private-workers"
  dns_label                  = "workers"
  prohibit_public_ip_on_vnic = true
  route_table_id             = oci_core_route_table.private.id

  # See note on `oci_core_subnet.public.security_list_ids`.
  security_list_ids = var.enable_security_lists ? [oci_core_security_list.private[0].id] : null

  # Security-list attachment is a bootstrap-time decision; ignore drift so
  # envs that disabled module-owned SLs aren't forced to swap off the
  # default SL, and envs that enabled them aren't surprised by manual
  # additions in OCI console.
  lifecycle {
    ignore_changes = [security_list_ids]
  }

  freeform_tags = var.tags
}

# -----------------------------------------------------------------------------
# Private Subnet — Pods (regional, for VCN-native pod networking)
# Used for: OKE pods when using VCN-native CNI
# -----------------------------------------------------------------------------
resource "oci_core_subnet" "private_pods" {
  compartment_id             = var.compartment_id
  vcn_id                     = oci_core_vcn.main.id
  cidr_block                 = cidrsubnet(var.cidr, 2, 2) # /18 — large range for pods
  display_name               = "${var.name}-private-pods"
  dns_label                  = "pods"
  prohibit_public_ip_on_vnic = true
  route_table_id             = oci_core_route_table.private.id

  # See note on `oci_core_subnet.public.security_list_ids`.
  security_list_ids = var.enable_security_lists ? [oci_core_security_list.private[0].id] : null

  # See note on `oci_core_subnet.private_workers.lifecycle`.
  lifecycle {
    ignore_changes = [security_list_ids]
  }

  freeform_tags = var.tags
}

# -----------------------------------------------------------------------------
# Network Security Group — OKE API Endpoint
#
# NSGs are gated by `enable_oke_nsgs` because the live staging cluster was
# bootstrapped without them (OKE security comes from default security lists
# in that case). Production / greenfield envs should leave this `true`.
# -----------------------------------------------------------------------------
resource "oci_core_network_security_group" "oke_api" {
  count = var.enable_oke_nsgs ? 1 : 0

  compartment_id = var.compartment_id
  vcn_id         = oci_core_vcn.main.id
  display_name   = "${var.name}-oke-api-nsg"

  freeform_tags = var.tags
}

resource "oci_core_network_security_group_security_rule" "oke_api_ingress" {
  for_each = var.enable_oke_nsgs ? toset(var.oke_api_allowed_cidrs) : toset([])

  network_security_group_id = oci_core_network_security_group.oke_api[0].id
  direction                 = "INGRESS"
  protocol                  = "6" # TCP
  source                    = each.value
  source_type               = "CIDR_BLOCK"
  stateless                 = false

  tcp_options {
    destination_port_range {
      min = 6443
      max = 6443
    }
  }
}

resource "oci_core_network_security_group_security_rule" "oke_api_egress" {
  count = var.enable_oke_nsgs ? 1 : 0

  network_security_group_id = oci_core_network_security_group.oke_api[0].id
  direction                 = "EGRESS"
  protocol                  = "all"
  destination               = "0.0.0.0/0"
  destination_type          = "CIDR_BLOCK"
  stateless                 = false
}

# -----------------------------------------------------------------------------
# Network Security Group — OKE Workers
# -----------------------------------------------------------------------------
resource "oci_core_network_security_group" "oke_workers" {
  count = var.enable_oke_nsgs ? 1 : 0

  compartment_id = var.compartment_id
  vcn_id         = oci_core_vcn.main.id
  display_name   = "${var.name}-oke-workers-nsg"

  freeform_tags = var.tags
}

resource "oci_core_network_security_group_security_rule" "workers_ingress_from_vcn" {
  count = var.enable_oke_nsgs ? 1 : 0

  network_security_group_id = oci_core_network_security_group.oke_workers[0].id
  direction                 = "INGRESS"
  protocol                  = "all"
  source                    = var.cidr
  source_type               = "CIDR_BLOCK"
  stateless                 = false
}

resource "oci_core_network_security_group_security_rule" "workers_egress" {
  count = var.enable_oke_nsgs ? 1 : 0

  network_security_group_id = oci_core_network_security_group.oke_workers[0].id
  direction                 = "EGRESS"
  protocol                  = "all"
  destination               = "0.0.0.0/0"
  destination_type          = "CIDR_BLOCK"
  stateless                 = false
}

# Allow load balancer health checks to reach workers (NodePort range)
resource "oci_core_network_security_group_security_rule" "workers_ingress_lb" {
  count = var.enable_oke_nsgs ? 1 : 0

  network_security_group_id = oci_core_network_security_group.oke_workers[0].id
  direction                 = "INGRESS"
  protocol                  = "6"
  source                    = cidrsubnet(var.cidr, 4, 0) # public subnet CIDR
  source_type               = "CIDR_BLOCK"
  stateless                 = false

  tcp_options {
    destination_port_range {
      min = 30000
      max = 32767
    }
  }
}

# -----------------------------------------------------------------------------
# Outputs
# -----------------------------------------------------------------------------
output "vcn_id" {
  description = "VCN OCID"
  value       = oci_core_vcn.main.id
}

output "public_subnet_id" {
  description = "Public subnet OCID"
  value       = oci_core_subnet.public.id
}

output "private_workers_subnet_id" {
  description = "Private workers subnet OCID"
  value       = oci_core_subnet.private_workers.id
}

output "private_pods_subnet_id" {
  description = "Private pods subnet OCID (for VCN-native pod networking)"
  value       = oci_core_subnet.private_pods.id
}

output "oke_api_nsg_id" {
  description = "NSG OCID for OKE API endpoint (null when `enable_oke_nsgs = false`)"
  value       = var.enable_oke_nsgs ? oci_core_network_security_group.oke_api[0].id : null
}

output "oke_workers_nsg_id" {
  description = "NSG OCID for OKE worker nodes (null when `enable_oke_nsgs = false`)"
  value       = var.enable_oke_nsgs ? oci_core_network_security_group.oke_workers[0].id : null
}

output "nat_gateway_id" {
  description = "NAT Gateway OCID"
  value       = oci_core_nat_gateway.main.id
}

output "service_gateway_id" {
  description = "Service Gateway OCID"
  value       = oci_core_service_gateway.main.id
}
