resource "google_artifact_registry_repository" "portal" {
  project       = var.project_id
  location      = var.region
  repository_id = "portal"
  description   = "Immutable images for the isolated portal units"
  format        = "DOCKER"
  docker_config { immutable_tags = true }
  depends_on = [google_project_service.apis]
}

# Two Cloud Run services are Terraform-created: the synthetic probe and the
# portal-web shell. Both start from the probe image. Production revision
# fields are controller-owned: image, env, secret versions, resources,
# concurrency, scaling and traffic are never managed by a later foundation apply.
resource "google_cloud_run_v2_service" "probe" {
  provider            = google-beta
  count               = var.enable_synthetic_probe ? 1 : 0
  project             = var.project_id
  name                = "portal-probe"
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
        network    = google_compute_network.portal.id
        subnetwork = google_compute_subnetwork.portal.id
        tags       = ["portal-probe"]
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

# The real employee entry point. Terraform owns the service shell — IAP
# enablement, ingress, the IAP service-agent invoker and the Workspace group
# binding — and nothing else. The bootstrap template is the probe image; the
# release controller replaces it and must carry the foundation-owned service
# annotations forward (release.py FOUNDATION_SERVICE_ANNOTATIONS) so a promotion
# can never switch IAP off.
resource "google_cloud_run_v2_service" "web" {
  provider            = google-beta
  project             = var.project_id
  name                = "portal-web"
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
        network    = google_compute_network.portal.id
        subnetwork = google_compute_subnetwork.portal.id
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
    ignore_changes = [template, traffic, labels, annotations, client, client_version]
  }
  depends_on = [google_project_service.apis, google_project_iam_member.serverless_network_user]
}

resource "google_cloud_run_v2_service_iam_member" "web_iap_invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.web.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:service-${data.google_project.current.number}@gcp-sa-iap.iam.gserviceaccount.com"
}

resource "google_iap_web_cloud_run_service_iam_binding" "web_group" {
  project                = var.project_id
  location               = var.region
  cloud_run_service_name = google_cloud_run_v2_service.web.name
  role                   = "roles/iap.httpsResourceAccessor"
  members                = ["group:${var.iap_workspace_group}"]
}

# Audiences are derived, never typed: the IAP assertion audience for the web
# entry and the deterministic run.app URL each receiver presents as its service
# token audience. The release controller reads these from `terraform output`.
locals {
  receiver_services = toset(["portal-query", "portal-ingest", "portal-actions"])
  service_urls      = { for name in local.receiver_services : name => "https://${name}-${data.google_project.current.number}.${var.region}.run.app" }
  service_audiences = merge(local.service_urls, {
    (google_cloud_run_v2_service.web.name) = "/projects/${data.google_project.current.number}/locations/${var.region}/services/${google_cloud_run_v2_service.web.name}"
  })
}
