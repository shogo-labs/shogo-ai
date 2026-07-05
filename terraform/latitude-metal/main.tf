# =============================================================================
# Latitude.sh bare-metal fleet — cloud-agnostic Firecracker runtime substrate
# =============================================================================
# Provisions the bare-metal host(s) that run project runtimes as Firecracker
# microVMs, INDEPENDENT of OCI/OKE (Cloud Firecracker snapshots plan — cloud-
# agnostic track). Latitude gives true bare metal with local NVMe + a public
# IP (direct SSH, no bastion) and hourly billing.
#
# Auth: export LATITUDESH_AUTH_TOKEN=<token>  (never commit the token).
# State: LOCAL for now — graduates to the shared remote backend once the
# substrate architecture is locked (see README).
#
# Pilot host = c3-large-x86: 24c EPYC 7443P Milan / 256 GB / 2x1.9TB NVMe /
# ~$1.36/hr (~$496/mo), NYC (closest in-stock US site to OCI us-ashburn-1;
# ASH itself is currently out of stock for this plan).
# =============================================================================

# Token is read from the LATITUDESH_AUTH_TOKEN environment variable.
provider "latitudesh" {}

variable "project_name" {
  type    = string
  default = "shogo-firecracker"
}

variable "environment" {
  description = "Latitude project environment tag."
  type        = string
  default     = "Development"
}

variable "plan" {
  description = "Latitude plan slug. c3-large-x86 = 256 GB / 24c EPYC 7443P Milan / 2x1.9TB NVMe / ~$496/mo."
  type        = string
  default     = "c3-large-x86"
}

variable "site" {
  # ASH (same metro as OCI us-ashburn-1) is out of stock for c3-large-x86;
  # NYC is the closest in-stock US site (~330km / single-digit ms to Ashburn).
  # In-stock US sites for this plan: DAL, LAX, NYC, MIA2.
  description = "Latitude site. NYC = closest in-stock site to OCI us-ashburn-1."
  type        = string
  default     = "NYC"
}

variable "operating_system" {
  type    = string
  default = "ubuntu_24_04_x64_lts"
}

variable "server_count" {
  description = "Number of bare-metal hosts in the fleet."
  type        = number
  default     = 1
}

variable "ssh_public_key_file" {
  type    = string
  default = "~/.ssh/id_ed25519.pub"
}

variable "enable_first_boot_bootstrap" {
  description = <<-EOT
    When true, cloud-init runs scripts/metal-agent/host-bootstrap.sh on first
    boot (firecracker + kernel + bun + ip_forward + a stopped
    metal-agent.service). Leave FALSE for the already-provisioned pilot host so
    its user_data hash is unchanged (changing user_data triggers a destructive
    reinstall via allowed_reinstall_triggers). Set TRUE for fresh fleet nodes.
  EOT
  type        = bool
  default     = false
}

resource "latitudesh_project" "fc" {
  name              = var.project_name
  environment       = var.environment
  provisioning_type = "on_demand"
}

resource "latitudesh_ssh_key" "fc" {
  name       = "shogo-fc"
  public_key = trimspace(file(pathexpand(var.ssh_public_key_file)))
}

# The server-level `ssh_keys` association is unreliable on Latitude (the key
# does not land in root's authorized_keys on deploy/reinstall). cloud-init runs
# deterministically after every deploy, so we inject the key here as the source
# of truth for host access.
#
# `cloud_init_min` is the SSH-only payload the live pilot was provisioned with;
# keeping it byte-identical when enable_first_boot_bootstrap=false avoids a
# destructive reinstall. Fresh fleet nodes flip the flag to get the full
# host-bootstrap on first boot (templates/cloud-init.yaml.tftpl).
locals {
  ssh_public_key = trimspace(file(pathexpand(var.ssh_public_key_file)))

  cloud_init_min = <<-EOT
    #cloud-config
    disable_root: false
    ssh_pwauth: false
    runcmd:
      - mkdir -p /root/.ssh && chmod 700 /root/.ssh
      - echo '${local.ssh_public_key}' >> /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys
  EOT

  cloud_init_full = templatefile("${path.module}/templates/cloud-init.yaml.tftpl", {
    enable_bootstrap = true
    ssh_public_key   = local.ssh_public_key
    bootstrap_script = file("${path.module}/../../scripts/metal-agent/host-bootstrap.sh")
  })

  cloud_init = var.enable_first_boot_bootstrap ? local.cloud_init_full : local.cloud_init_min
}

resource "latitudesh_user_data" "fc" {
  description = "shogo-fc-bootstrap"
  content     = base64encode(local.cloud_init)
}

resource "latitudesh_server" "fc" {
  count            = var.server_count
  project          = latitudesh_project.fc.id
  hostname         = "shogo-fc-${count.index}"
  plan             = var.plan
  site             = var.site
  operating_system = var.operating_system
  billing          = "hourly"
  ssh_keys         = [latitudesh_ssh_key.fc.id]
  user_data        = latitudesh_user_data.fc.id

  # Let user_data changes drive an in-place reinstall rather than a full
  # destroy/recreate.
  allow_reinstall            = true
  allowed_reinstall_triggers = ["user_data"]
}

output "server_ips" {
  description = "Public IPv4 of each host — feed into run-spike-ssh.sh as SSH_TARGET=root@<ip>."
  value       = latitudesh_server.fc[*].primary_ipv4
}

output "benchmark_hint" {
  value = length(latitudesh_server.fc) > 0 ? "SSH_TARGET=root@${latitudesh_server.fc[0].primary_ipv4} bash scripts/firecracker-spike/run-spike-ssh.sh" : "no servers"
}
