# =============================================================================
# releases.shogo.ai — resolver Worker + DNS + route
# =============================================================================

resource "cloudflare_worker_script" "releases" {
  account_id = var.cloudflare_account_id
  name       = local.releases_worker_name
  module     = true

  content = templatefile("${path.module}/scripts/releases-worker.js.tftpl", {
    github_owner = var.github_owner
    github_repo  = var.github_repo
  })

  # Bind the optional GH token as `GITHUB_TOKEN` inside the Worker.
  # Without it the resolver falls back to the 60/hr anonymous GitHub
  # quota — fine for staging but tight for production once the install
  # one-liner is in the wild.
  dynamic "secret_text_binding" {
    for_each = var.github_token == null ? [] : [var.github_token]
    content {
      name = "GITHUB_TOKEN"
      text = secret_text_binding.value
    }
  }
}

resource "cloudflare_record" "releases" {
  zone_id = var.cloudflare_zone_id
  name    = "releases"

  # Documentation IP, never reached — same trick as `install` above.
  content         = "192.0.2.1"
  type            = "A"
  proxied         = true
  allow_overwrite = true
}

resource "cloudflare_worker_route" "releases" {
  zone_id     = var.cloudflare_zone_id
  pattern     = "releases.${var.domain}/*"
  script_name = cloudflare_worker_script.releases.name
}
