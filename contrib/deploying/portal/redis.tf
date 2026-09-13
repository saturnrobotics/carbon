resource "google_redis_instance" "portal" {
  project                 = var.project_id
  name                    = "portal-${var.environment}"
  tier                    = "BASIC"
  memory_size_gb          = 1
  region                  = var.region
  redis_version           = "REDIS_7_0"
  authorized_network      = google_compute_network.portal.id
  connect_mode            = "PRIVATE_SERVICE_ACCESS"
  auth_enabled            = true
  transit_encryption_mode = "SERVER_AUTHENTICATION"
  depends_on              = [google_service_networking_connection.private_service_access]
}
