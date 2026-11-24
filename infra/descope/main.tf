# Settings of the existing "Grimoire dev" project that the sign-in needs. The project
# itself is not managed here, so nothing in it is created or deleted.

resource "descope_project_settings" "dev" {
  project_id       = var.project_id
  app_url          = var.app_url
  approved_domains = var.approved_domains
}

# One-time code by email, through the built-in delivery service.
resource "descope_otp_settings" "dev" {
  project_id = var.project_id
  disabled   = false
}
