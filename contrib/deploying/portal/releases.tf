# Terraform owns foundation/IAM/network resources only. The release controller
# owns every mutable service/job revision spec and rejects drift before promotion.
# It is intentionally not represented by google_cloud_run_v2_service resources.

resource "google_service_account_iam_member" "cloudbuild_deployer" {
  service_account_id = google_service_account.runtime["deployment"].name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${data.google_project.current.number}@cloudbuild.gserviceaccount.com"
}
