locals {
  runtime_identities = toset(["deployment", "web", "query", "ingest", "parser", "migration", "maintenance", "scheduler"])
  secret_names = toset([
    "portal-read-db-url",
    "portal-review-db-url",
    "portal-ingest-db-url",
    "portal-migration-db-url",
    "portal-maintenance-db-url",
    "portal-source-database-ca",
    "portal-redis-url",
    "portal-redis-ca",
    "portal-inngest-signing-key",
  ])
}

resource "google_service_account" "runtime" {
  for_each     = local.runtime_identities
  project      = var.project_id
  account_id   = "portal-${each.value}"
  display_name = "Portal ${each.value} workload identity"
}

# The deployment identity gets only a reviewed custom role. Runtime identities
# never receive project-wide runtime admin, editor, owner, or key-creation roles.
resource "google_project_iam_custom_role" "release_controller" {
  project     = var.project_id
  role_id     = "portalReleaseController"
  title       = "Portal release controller"
  permissions = ["run.services.create", "run.services.get", "run.services.update", "run.jobs.create", "run.jobs.get", "run.jobs.update", "run.operations.get"]
}

resource "google_project_iam_member" "deployment_controller" {
  project = var.project_id
  role    = google_project_iam_custom_role.release_controller.name
  member  = "serviceAccount:${google_service_account.runtime["deployment"].email}"
  condition {
    title      = "portal_units_only"
    expression = "resource.name.startsWith('projects/${var.project_id}/locations/${var.region}/services/portal-') || resource.name.startsWith('projects/${var.project_id}/locations/${var.region}/jobs/portal-')"
  }
}

resource "google_artifact_registry_repository_iam_member" "deployment_writer" {
  project    = var.project_id
  location   = var.region
  repository = google_artifact_registry_repository.portal.name
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

# portal-source-database-ca holds only Carbon's private PostgreSQL CA
# certificate (ca.crt), so database clients can require sslmode=verify-full
# against the listener's IP SAN. Every identity that holds a database URL holds
# the CA; web and parser hold neither.
locals {
  secret_access = {
    web         = []
    query       = ["portal-read-db-url", "portal-source-database-ca", "portal-redis-url", "portal-redis-ca"]
    ingest      = ["portal-review-db-url", "portal-read-db-url", "portal-ingest-db-url", "portal-source-database-ca", "portal-inngest-signing-key"]
    parser      = []
    migration   = ["portal-migration-db-url", "portal-source-database-ca"]
    maintenance = ["portal-maintenance-db-url", "portal-source-database-ca"]
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

# Employee forwarding edges (platform plan §1.4). Each caller may invoke exactly
# one named receiver; the receiver still verifies the service token and the
# forwarded IAP assertion itself. Receivers are controller-created, so the grant
# is a project member bound by an exact resource.name condition rather than a
# service-level binding that cannot exist before the first release.
locals {
  invoker_edges = {
    "web-query"        = { caller = "web", receiver = "portal-query" }
    "web-actions"      = { caller = "web", receiver = "portal-actions" }
    "web-ingest"       = { caller = "web", receiver = "portal-ingest" }
    "ingest-query"     = { caller = "ingest", receiver = "portal-query" }
    "scheduler-ingest" = { caller = "scheduler", receiver = "portal-ingest" }
  }
}

resource "google_project_iam_member" "service_invoker" {
  for_each = local.invoker_edges
  project  = var.project_id
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.runtime[each.value.caller].email}"
  condition {
    title      = "portal_${replace(each.key, "-", "_")}_only"
    expression = "resource.name == 'projects/${var.project_id}/locations/${var.region}/services/${each.value.receiver}'"
  }
}

# The ingestion worker supplies per-capture environment overrides when starting
# the parser job, requiring runWithOverrides as well as run (run.invoker alone
# does not grant overrides). It cannot update the job's saved configuration.
# https://cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs/run
# Operation polling is a separate read-only API permission because Cloud Run
# operation resources do not carry their originating job name for an IAM condition.
resource "google_project_iam_custom_role" "parser_job_executor" {
  project     = var.project_id
  role_id     = "portalParserJobExecutor"
  title       = "Portal parser job executor"
  permissions = ["run.jobs.run", "run.jobs.runWithOverrides"]
}

resource "google_project_iam_member" "ingest_parser_invoker" {
  project = var.project_id
  role    = google_project_iam_custom_role.parser_job_executor.name
  member  = "serviceAccount:${google_service_account.runtime["ingest"].email}"
  condition {
    title      = "portal_parser_job_only"
    expression = "resource.name == 'projects/${var.project_id}/locations/${var.region}/jobs/portal-parser'"
  }
}

resource "google_project_iam_custom_role" "parser_operation_reader" {
  project     = var.project_id
  role_id     = "portalParserOperationReader"
  title       = "Portal parser operation reader"
  permissions = ["run.operations.get"]
}

resource "google_project_iam_member" "ingest_parser_operation_reader" {
  project = var.project_id
  role    = google_project_iam_custom_role.parser_operation_reader.name
  member  = "serviceAccount:${google_service_account.runtime["ingest"].email}"
}

# The descriptor is foundation-owned. Ingest can emit observations, never create
# or edit metric descriptors, alert policies, or monitoring configuration.
resource "google_project_iam_custom_role" "ingest_metrics_writer" {
  project     = var.project_id
  role_id     = "portalIngestMetricsWriter"
  title       = "Portal ingestion database metrics writer"
  permissions = ["monitoring.timeSeries.create"]
}

resource "google_project_iam_member" "ingest_metrics_writer" {
  project = var.project_id
  role    = google_project_iam_custom_role.ingest_metrics_writer.name
  member  = "serviceAccount:${google_service_account.runtime["ingest"].email}"
}

resource "google_project_iam_member" "maintenance_retention_invoker" {
  project = var.project_id
  role    = "roles/run.invoker"
  member  = "serviceAccount:${google_service_account.runtime["maintenance"].email}"
  condition {
    title      = "portal_retention_job_only"
    expression = "resource.name == 'projects/${var.project_id}/locations/${var.region}/jobs/portal-retention'"
  }
}

resource "google_cloud_scheduler_job" "retention" {
  project          = var.project_id
  region           = var.region
  name             = "portal-retention"
  description      = "Run bounded fixed-policy portal retention"
  schedule         = "17 3 * * *"
  time_zone        = "Etc/UTC"
  attempt_deadline = "900s"
  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/portal-retention:run"
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

# Both jobs start paused. The release controller manually runs the no-work check
# and verifies its completed authenticated attempt before enabling drain. A later
# Terraform apply must preserve that release-owned pause state.
resource "google_cloud_scheduler_job" "outbox" {
  for_each         = toset(["drain", "check"])
  project          = var.project_id
  region           = var.region
  name             = "portal-outbox-${each.value}"
  description      = "Bounded Portal outbox ${each.value}"
  schedule         = "* * * * *"
  time_zone        = "Etc/UTC"
  attempt_deadline = "450s"
  paused           = true
  http_target {
    http_method = "POST"
    uri         = "${local.service_urls["portal-ingest"]}/internal/outbox/${each.value}"
    headers     = { "Content-Type" = "application/json" }
    oidc_token {
      service_account_email = google_service_account.runtime["scheduler"].email
      audience              = local.service_urls["portal-ingest"]
    }
  }
  # API defaults set both retry count and duration to zero, disabling retries.
  # Omit the empty block: the API omits it on read, causing perpetual plan drift.
  lifecycle {
    ignore_changes = [paused]
  }
  depends_on = [google_project_service.apis, google_project_iam_member.service_invoker]
}

# There is deliberately no google_iap_client or google_iap_brand here. IAP on
# Cloud Run uses a Google-managed OAuth client for in-organization Workspace
# users, which is the only admission this deployment allows, and the provider
# marks both resources deprecated: the IAP OAuth Admin API behind them stopped
# functioning after July 2025. See README "IAP client and audiences".
