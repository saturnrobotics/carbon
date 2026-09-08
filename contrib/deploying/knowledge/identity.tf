locals {
  runtime_identities = toset(["deployment", "web", "query", "ingest", "parser", "migration", "maintenance"])
  secret_names = toset([
    "knowledge-read-db-url",
    "knowledge-review-db-url",
    "knowledge-ingest-db-url",
    "knowledge-migration-db-url",
    "knowledge-maintenance-db-url",
    "knowledge-redis-url",
    "knowledge-inngest-signing-key",
  ])
}

resource "google_service_account" "runtime" {
  for_each     = local.runtime_identities
  project      = var.project_id
  account_id   = "knowledge-${each.value}"
  display_name = "Knowledge ${each.value} workload identity"
}

# The deployment identity gets only a reviewed custom role. Runtime identities
# never receive project-wide runtime admin, editor, owner, or key-creation roles.
resource "google_project_iam_custom_role" "release_controller" {
  project     = var.project_id
  role_id     = "knowledgeReleaseController"
  title       = "Knowledge release controller"
  permissions = ["run.services.create", "run.services.get", "run.services.update", "run.jobs.create", "run.jobs.get", "run.jobs.update", "run.operations.get"]
}

resource "google_project_iam_member" "deployment_controller" {
  project = var.project_id
  role    = google_project_iam_custom_role.release_controller.name
  member  = "serviceAccount:${google_service_account.runtime["deployment"].email}"
  condition {
    title      = "knowledge_units_only"
    expression = "resource.name.startsWith('projects/${var.project_id}/locations/${var.region}/services/knowledge-') || resource.name.startsWith('projects/${var.project_id}/locations/${var.region}/jobs/knowledge-')"
  }
}

resource "google_artifact_registry_repository_iam_member" "deployment_writer" {
  project    = var.project_id
  location   = var.region
  repository = google_artifact_registry_repository.knowledge.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.runtime["deployment"].email}"
}

resource "google_secret_manager_secret" "runtime" {
  for_each  = local.secret_names
  project   = var.project_id
  secret_id = each.value
  replication {
    auto {}
  }
  lifecycle {
    prevent_destroy = true
  }
}

locals {
  secret_access = {
    web         = []
    query       = ["knowledge-read-db-url", "knowledge-redis-url"]
    ingest      = ["knowledge-review-db-url", "knowledge-read-db-url", "knowledge-ingest-db-url", "knowledge-inngest-signing-key"]
    parser      = []
    migration   = ["knowledge-migration-db-url"]
    maintenance = ["knowledge-maintenance-db-url"]
  }
  secret_grants = merge([for identity, secrets in local.secret_access : { for secret in secrets : "${identity}/${secret}" => { identity = identity, secret = secret } }]...)
}

resource "google_secret_manager_secret_iam_member" "runtime" {
  for_each  = local.secret_grants
  project   = var.project_id
  secret_id = google_secret_manager_secret.runtime[each.value.secret].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime[each.value.identity].email}"
}

# The ingestion worker can start only the parser job. Operation polling is a
# separate read-only API permission because Cloud Run operation resources do not
# carry their originating job name for an IAM condition.
resource "google_project_iam_member" "ingest_parser_invoker" {
  project = var.project_id
  role    = "roles/run.invoker"
  member  = "serviceAccount:${google_service_account.runtime["ingest"].email}"
  condition {
    title      = "knowledge_parser_job_only"
    expression = "resource.name == 'projects/${var.project_id}/locations/${var.region}/jobs/knowledge-parser'"
  }
}

resource "google_project_iam_custom_role" "parser_operation_reader" {
  project     = var.project_id
  role_id     = "knowledgeParserOperationReader"
  title       = "Knowledge parser operation reader"
  permissions = ["run.operations.get"]
}

resource "google_project_iam_member" "ingest_parser_operation_reader" {
  project = var.project_id
  role    = google_project_iam_custom_role.parser_operation_reader.name
  member  = "serviceAccount:${google_service_account.runtime["ingest"].email}"
}

resource "google_project_iam_member" "maintenance_retention_invoker" {
  project = var.project_id
  role    = "roles/run.invoker"
  member  = "serviceAccount:${google_service_account.runtime["maintenance"].email}"
  condition {
    title      = "knowledge_retention_job_only"
    expression = "resource.name == 'projects/${var.project_id}/locations/${var.region}/jobs/knowledge-retention'"
  }
}

resource "google_cloud_scheduler_job" "retention" {
  project          = var.project_id
  region           = var.region
  name             = "knowledge-retention"
  description      = "Run bounded fixed-policy knowledge retention"
  schedule         = "17 3 * * *"
  time_zone        = "Etc/UTC"
  attempt_deadline = "900s"
  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/knowledge-retention:run"
    oauth_token {
      service_account_email = google_service_account.runtime["maintenance"].email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }
  retry_config {
    retry_count          = 3
    max_retry_duration   = "1800s"
    min_backoff_duration = "30s"
    max_backoff_duration = "300s"
  }
  depends_on = [google_project_service.apis, google_project_iam_member.maintenance_retention_invoker]
}
