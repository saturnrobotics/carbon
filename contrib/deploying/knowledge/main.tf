terraform {
  required_version = ">= 1.8.0"
  required_providers {
    google      = { source = "hashicorp/google", version = "~> 6.0" }
    google-beta = { source = "hashicorp/google-beta", version = "~> 6.0" }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
provider "google-beta" {
  project = var.project_id
  region  = var.region
}

data "google_project" "current" { project_id = var.project_id }

resource "google_project_service" "apis" {
  for_each           = toset(["artifactregistry.googleapis.com", "cloudbuild.googleapis.com", "cloudscheduler.googleapis.com", "compute.googleapis.com", "iap.googleapis.com", "logging.googleapis.com", "monitoring.googleapis.com", "redis.googleapis.com", "run.googleapis.com", "secretmanager.googleapis.com", "servicenetworking.googleapis.com", "storage.googleapis.com"])
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}
