locals {
  portal_log_alerts = {
    auth-denials = {
      filter    = "resource.type=\"cloud_run_revision\" AND jsonPayload.stage=\"authentication\" AND jsonPayload.outcome=\"deny\""
      threshold = 10
    }
    source-errors = {
      filter    = "resource.type=\"cloud_run_revision\" AND jsonPayload.stage=\"source\" AND jsonPayload.outcome=\"error\""
      threshold = 0
    }
    model-errors = {
      filter    = "resource.type=\"cloud_run_revision\" AND jsonPayload.stage=\"model\" AND jsonPayload.outcome=\"error\""
      threshold = 0
    }
    cache-policy-errors = {
      filter    = "resource.type=\"cloud_run_revision\" AND jsonPayload.stage=\"cache\" AND jsonPayload.outcome=\"error\""
      threshold = 0
    }
    indexing-errors = {
      filter    = "resource.type=\"cloud_run_revision\" AND jsonPayload.stage=\"indexing\" AND jsonPayload.outcome=~\"error|timeout\""
      threshold = 0
    }
    retention-errors = {
      filter    = "resource.type=\"cloud_run_job\" AND jsonPayload.stage=\"retention\" AND jsonPayload.outcome=\"error\""
      threshold = 0
    }
    # The query service's periodic cache-isolation self-test reports a leak as a
    # `security` error; an unreachable store is a `cache` error (above), so an
    # outage never fires this policy.
    cache-leakage = {
      filter    = "resource.type=\"cloud_run_revision\" AND jsonPayload.stage=\"security\" AND jsonPayload.outcome=\"error\""
      threshold = 0
    }
  }
  # Numeric backlog ages the ingestion worker emits after every delivery pass
  # (`jsonPayload.stage="indexing"`, telemetry allowlist keys). Both are seconds.
  portal_backlog_alerts = {
    indexing-lag = {
      field       = "lagSeconds"
      description = "oldest undelivered outbox row (index or ACL staleness) above fifteen minutes"
      threshold   = 900
    }
    outbox-queue-age = {
      field       = "queueSeconds"
      description = "oldest claimable but unclaimed outbox row above ten minutes"
      threshold   = 600
    }
  }
}

resource "google_logging_metric" "portal_alert" {
  for_each = local.portal_log_alerts
  project  = var.project_id
  name     = "portal/${each.key}"
  filter   = each.value.filter
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

resource "google_monitoring_alert_policy" "portal_log_alert" {
  for_each              = local.portal_log_alerts
  project               = var.project_id
  display_name          = "Portal ${each.key}"
  combiner              = "OR"
  notification_channels = var.monitoring_notification_channels
  conditions {
    display_name = each.key
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.portal_alert[each.key].name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = each.value.threshold
      duration        = "300s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }
  alert_strategy {
    auto_close = "1800s"
  }
}

resource "google_logging_metric" "portal_backlog" {
  for_each        = local.portal_backlog_alerts
  project         = var.project_id
  name            = "portal/${each.key}-seconds"
  filter          = "resource.type=\"cloud_run_revision\" AND jsonPayload.stage=\"indexing\" AND jsonPayload.outcome=\"success\" AND jsonPayload.${each.value.field}:*"
  value_extractor = "EXTRACT(jsonPayload.${each.value.field})"
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
  }
  bucket_options {
    exponential_buckets {
      num_finite_buckets = 16
      growth_factor      = 2
      scale              = 1
    }
  }
}

resource "google_monitoring_alert_policy" "portal_backlog" {
  for_each              = local.portal_backlog_alerts
  project               = var.project_id
  display_name          = "Portal ${each.key}"
  combiner              = "OR"
  notification_channels = var.monitoring_notification_channels
  conditions {
    display_name = each.value.description
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.portal_backlog[each.key].name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = each.value.threshold
      duration        = "300s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_PERCENTILE_99"
      }
    }
  }
  alert_strategy {
    auto_close = "1800s"
  }
}

resource "google_logging_metric" "portal_request_latency" {
  project = var.project_id
  name    = "portal/request-latency-ms"
  filter  = "resource.type=\"cloud_run_revision\" AND jsonPayload.stage=\"request\" AND jsonPayload.outcome=~\"success|error|timeout\""
  # Telemetry records are flat (`packages/portal/src/telemetry.ts`); the
  # metric keys sit beside `stage`, not under a `metrics` object.
  value_extractor = "EXTRACT(jsonPayload.durationMs)"
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
  }
  bucket_options {
    exponential_buckets {
      num_finite_buckets = 12
      growth_factor      = 2
      scale              = 10
    }
  }
}

resource "google_monitoring_alert_policy" "portal_request_latency" {
  project               = var.project_id
  display_name          = "Portal request p99 latency"
  combiner              = "OR"
  notification_channels = var.monitoring_notification_channels
  conditions {
    display_name = "p99 latency above ten seconds"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.portal_request_latency.name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 10000
      duration        = "300s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_PERCENTILE_99"
      }
    }
  }
}

resource "google_monitoring_alert_policy" "portal_database_saturation" {
  project               = var.project_id
  display_name          = "Portal database connection saturation"
  combiner              = "OR"
  notification_channels = var.monitoring_notification_channels
  conditions {
    display_name = "connection utilization above 85 percent"
    condition_threshold {
      filter          = "metric.type=\"${var.database_connection_utilization_metric_type}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0.85
      duration        = "300s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }
}
