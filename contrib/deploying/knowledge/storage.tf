resource "google_storage_bucket" "knowledge" {
  project                     = var.project_id
  name                        = "${var.project_id}-knowledge-${var.environment}"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  versioning {
    enabled = true
  }
  retention_policy {
    retention_period = 2592000
  }
  lifecycle_rule {
    action { type = "Delete" }
    condition {
      age                = 365
      num_newer_versions = 3
    }
  }
}

resource "google_storage_bucket_iam_member" "ingest_write" {
  bucket = google_storage_bucket.knowledge.name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${google_service_account.runtime["ingest"].email}"
}
resource "google_storage_bucket_iam_member" "ingest_read" {
  bucket = google_storage_bucket.knowledge.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.runtime["ingest"].email}"
}
resource "google_storage_bucket_iam_member" "parser_read" {
  bucket = google_storage_bucket.knowledge.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.runtime["parser"].email}"
}
resource "google_storage_bucket_iam_member" "parser_write" {
  bucket = google_storage_bucket.knowledge.name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${google_service_account.runtime["parser"].email}"
}
resource "google_project_iam_custom_role" "retention_object_deleter" {
  project     = var.project_id
  role_id     = "knowledgeRetentionObjectDeleter"
  title       = "Knowledge retention object deleter"
  permissions = ["storage.objects.delete"]
}

resource "google_storage_bucket_iam_member" "maintenance_delete" {
  bucket = google_storage_bucket.knowledge.name
  role   = google_project_iam_custom_role.retention_object_deleter.name
  member = "serviceAccount:${google_service_account.runtime["maintenance"].email}"
}
