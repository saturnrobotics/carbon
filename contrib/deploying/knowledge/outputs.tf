output "artifact_repository" { value = google_artifact_registry_repository.knowledge.repository_id }
output "knowledge_bucket" { value = google_storage_bucket.knowledge.name }
output "runtime_service_accounts" { value = { for name, account in google_service_account.runtime : name => account.email } }
output "probe_url" { value = try(google_cloud_run_v2_service.probe[0].uri, null) }
