variable "project_id" {
  type = string
}
variable "region" {
  type = string
}
variable "environment" {
  type = string
  validation {
    condition     = contains(["nonproduction", "production"], var.environment)
    error_message = "environment must be nonproduction or production."
  }
}
variable "iap_workspace_group" {
  type = string
  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.iap_workspace_group))
    error_message = "Use a Google Group email address."
  }
}
variable "network_name" {
  type    = string
  default = "knowledge-private"
}
variable "subnet_cidr" {
  type    = string
  default = "10.82.0.0/24"
}
variable "private_source_cidrs" {
  type    = list(string)
  default = []
}
variable "enable_synthetic_probe" {
  type    = bool
  default = false
}
variable "probe_image" {
  type    = string
  default = ""
}

variable "monitoring_notification_channels" {
  description = "Existing Monitoring notification channel resource names"
  type        = list(string)
  default     = []
}

variable "database_connection_utilization_metric_type" {
  description = "Metric type emitted by the private PostgreSQL connection-pool exporter"
  type        = string
  validation {
    condition     = startswith(var.database_connection_utilization_metric_type, "custom.googleapis.com/")
    error_message = "Use the custom.googleapis.com metric emitted by the private connection-pool exporter."
  }
}
