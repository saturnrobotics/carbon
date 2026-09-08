resource "google_compute_network" "knowledge" {
  project                 = var.project_id
  name                    = var.network_name
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "knowledge" {
  project                  = var.project_id
  name                     = "knowledge-runtime"
  region                   = var.region
  network                  = google_compute_network.knowledge.id
  ip_cidr_range            = var.subnet_cidr
  private_ip_google_access = true
}

resource "google_compute_global_address" "private_service_access" {
  project       = var.project_id
  name          = "knowledge-private-service-access"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.knowledge.id
}

resource "google_service_networking_connection" "private_service_access" {
  network                 = google_compute_network.knowledge.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_service_access.name]
}

# The Cloud Run service agent needs this documented Direct VPC egress grant.
resource "google_project_iam_member" "serverless_network_user" {
  project = var.project_id
  role    = "roles/compute.networkUser"
  member  = "serviceAccount:service-${data.google_project.current.number}@serverless-robot-prod.iam.gserviceaccount.com"
}
