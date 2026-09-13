output "artifact_repository" { value = google_artifact_registry_repository.knowledge.repository_id }
output "knowledge_bucket" { value = google_storage_bucket.knowledge.name }
output "runtime_service_accounts" { value = { for name, account in google_service_account.runtime : name => account.email } }
output "probe_url" { value = try(google_cloud_run_v2_service.probe[0].uri, null) }
output "web_url" { value = google_cloud_run_v2_service.web.uri }

# Per-service audiences consumed by release.py --foundation-outputs. IAP uses
# the Google-managed OAuth client, so there is no client id to export.
output "service_audiences" { value = local.service_audiences }
output "service_urls" { value = local.service_urls }
output "source_database_client_tag" { value = local.source_database_client_tag }
