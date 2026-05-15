# =============================================================================
# install-shogo-ai — outputs
# =============================================================================

output "install_worker_name" {
  description = "Cloudflare Worker script name for install.<domain>"
  value       = cloudflare_worker_script.install_host.name
}

output "releases_worker_name" {
  description = "Cloudflare Worker script name for releases.<domain>"
  value       = cloudflare_worker_script.releases.name
}

output "install_url" {
  description = "Canonical install endpoint"
  value       = "https://install.${var.domain}"
}

output "releases_url" {
  description = "Canonical releases resolver endpoint"
  value       = "https://releases.${var.domain}"
}
