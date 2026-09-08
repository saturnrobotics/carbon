resource "google_artifact_registry_repository" "knowledge" {
  project       = var.project_id
  location      = var.region
  repository_id = "knowledge"
  description   = "Immutable images for the isolated knowledge units"
  format        = "DOCKER"
  docker_config { immutable_tags = true }
  depends_on = [google_project_service.apis]
}

# Only the synthetic probe is a Terraform-created Cloud Run service. Production
# revision fields are controller-owned: image, env, secret versions, resources,
# concurrency, scaling and traffic are never managed by a later foundation apply.
resource "google_cloud_run_v2_service" "probe" {
  provider            = google-beta
  count               = var.enable_synthetic_probe ? 1 : 0
  project             = var.project_id
  name                = "knowledge-probe"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  iap_enabled         = true
  deletion_protection = var.environment == "production"

  template {
    service_account                  = google_service_account.runtime["web"].email
    max_instance_request_concurrency = 10
    scaling {
      max_instance_count = 1
      min_instance_count = 0
    }
    vpc_access {
      egress = "ALL_TRAFFIC"
      network_interfaces {
        network    = google_compute_network.knowledge.id
        subnetwork = google_compute_subnetwork.knowledge.id
        tags       = ["knowledge-probe"]
      }
    }
    containers {
      image = var.probe_image
      ports { container_port = 8080 }
      resources { limits = { cpu = "1", memory = "256Mi" } }
    }
  }

  # revision fields are controller-owned after bootstrap; do not overwrite them.
  lifecycle {
    ignore_changes = [template]
  }
  depends_on = [google_project_service.apis, google_project_iam_member.serverless_network_user]
}

resource "google_cloud_run_v2_service_iam_member" "probe_iap_invoker" {
  count    = var.enable_synthetic_probe ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.probe[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:service-${data.google_project.current.number}@gcp-sa-iap.iam.gserviceaccount.com"
}

# Direct Cloud Run IAP authorizes this exact Workspace group. No public grant
# exists; the run.app URL is protected by IAP as well as custom domains.
resource "google_iap_web_cloud_run_service_iam_binding" "probe_group" {
  count                  = var.enable_synthetic_probe ? 1 : 0
  project                = var.project_id
  location               = var.region
  cloud_run_service_name = google_cloud_run_v2_service.probe[0].name
  role                   = "roles/iap.httpsResourceAccessor"
  members                = ["group:${var.iap_workspace_group}"]
}
