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

# Private source path to Carbon's PostgreSQL listener. This mirrors the Kanban
# client: VPC peering in both directions plus Direct VPC egress from a dedicated
# client subnet, no Cloud NAT and no public route. Carbon's own deployment
# admits only the client subnets listed in its POSTGRES_CLIENT_CIDRS, so
# var.subnet_cidr must appear there before the first connection can succeed.
locals {
  private_source_enabled = length(var.private_source_cidrs) > 0
  source_database_port   = "5432"
  # release.py stamps this tag only on units that hold a database credential.
  source_database_client_tag = "knowledge-source-database-client"
}

resource "google_compute_network_peering" "knowledge_to_source" {
  count        = var.private_source_network == "" ? 0 : 1
  name         = "knowledge-source-database"
  network      = google_compute_network.knowledge.id
  peer_network = var.private_source_network
  lifecycle {
    precondition {
      condition     = local.private_source_enabled
      error_message = "private_source_network requires private_source_cidrs; peering without a listener allow-list has no purpose."
    }
  }
}

resource "google_compute_network_peering" "source_to_knowledge" {
  count        = var.private_source_network == "" ? 0 : 1
  name         = "${var.network_name}-${var.environment}"
  network      = var.private_source_network
  peer_network = google_compute_network.knowledge.id
  depends_on   = [google_compute_network_peering.knowledge_to_source]
}

# Only tagged database clients may open TCP 5432 toward the listener; every
# other unit on the network is denied that destination explicitly. Transport
# security is the listener's TLS certificate, verified by clients through
# sslmode=verify-full and the CA held in knowledge-source-database-ca.
resource "google_compute_firewall" "source_database_egress" {
  count              = local.private_source_enabled ? 1 : 0
  project            = var.project_id
  name               = "knowledge-source-database-egress"
  network            = google_compute_network.knowledge.id
  direction          = "EGRESS"
  priority           = 900
  destination_ranges = var.private_source_cidrs
  target_tags        = [local.source_database_client_tag]
  allow {
    protocol = "tcp"
    ports    = [local.source_database_port]
  }
}

resource "google_compute_firewall" "source_database_egress_deny" {
  count              = local.private_source_enabled ? 1 : 0
  project            = var.project_id
  name               = "knowledge-source-database-egress-deny"
  network            = google_compute_network.knowledge.id
  direction          = "EGRESS"
  priority           = 1000
  destination_ranges = var.private_source_cidrs
  deny {
    protocol = "tcp"
    ports    = [local.source_database_port]
  }
}
