output "artifact_repository" { value = google_artifact_registry_repository.portal.repository_id }
output "portal_bucket" { value = google_storage_bucket.portal.name }
output "runtime_service_accounts" { value = { for name, account in google_service_account.runtime : name => account.email } }
output "probe_url" { value = try(google_cloud_run_v2_service.probe[0].uri, null) }
output "web_url" { value = google_cloud_run_v2_service.web.uri }

# Per-service audiences consumed by release.py --foundation-outputs. IAP uses
# the Google-managed OAuth client, so there is no client id to export.
output "service_audiences" { value = local.service_audiences }
output "service_urls" { value = local.service_urls }
output "source_database_client_tag" { value = local.source_database_client_tag }
output "database_connection_utilization_metric_type" { value = var.database_connection_utilization_metric_type }

output "outbox_scheduler" {
  value = {
    service_account = google_service_account.runtime["scheduler"].email
    subject         = google_service_account.runtime["scheduler"].unique_id
    audience        = local.service_urls["portal-ingest"]
    drain_job       = google_cloud_scheduler_job.outbox["drain"].id
    check_job       = google_cloud_scheduler_job.outbox["check"].id
  }
}
