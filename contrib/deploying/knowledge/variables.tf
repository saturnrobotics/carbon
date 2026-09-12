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
  description = "Carbon private PostgreSQL listener addresses reachable over peering (RFC1918 /24–/32); empty disables the private source path"
  type        = list(string)
  default     = []
  validation {
    condition = alltrue([
      for cidr in var.private_source_cidrs :
      can(cidrnetmask(cidr)) && cidrsubnet(cidr, 0, 0) == cidr && tonumber(split("/", cidr)[1]) >= 24 && can(regex("^(10\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.|192\\.168\\.)", cidr))
    ])
    error_message = "private_source_cidrs must contain canonical RFC1918 IPv4 /24–/32 subnets."
  }
}
variable "private_source_network" {
  description = "Carbon VM VPC to peer with, as projects/<project>/global/networks/<vm-name>-vpc; empty disables peering"
  type        = string
  default     = ""
  validation {
    condition     = var.private_source_network == "" || can(regex("^projects/[a-z][a-z0-9-]{4,28}[a-z0-9]/global/networks/[a-z][a-z0-9-]{0,61}[a-z0-9]$", var.private_source_network))
    error_message = "private_source_network must be empty or projects/<project>/global/networks/<network>."
  }
}
variable "enable_synthetic_probe" {
  type    = bool
  default = false
}
variable "probe_image" {
  description = "Digest-pinned synthetic probe image: the bootstrap shell for knowledge-web and the optional probe service; it has no source credentials or business handlers"
  type        = string
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$", var.probe_image))
    error_message = "probe_image must be an immutable image digest reference."
  }
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
