"""The connection alert must refer to the real worker-emitted metric."""
from pathlib import Path
import re
import unittest

from test_infrastructure import Configuration, parse_body, unquote


class DatabaseMonitoringTests(unittest.TestCase):
    def test_bootstrap_shells_match_provider_service_scaling_defaults(self):
        config = Configuration(Path(__file__).resolve().parent)
        for name in ("web", "probe"):
            with self.subTest(name=name):
                service = config.resources("google_cloud_run_v2_service")[name]
                scaling = service.child("scaling")
                self.assertIsNotNone(scaling, "Cloud Run returns a service scaling block even with default zero minimum")
                self.assertEqual(scaling.attrs["min_instance_count"], "0")

    def test_descriptor_matches_the_worker_sample_and_alert_scope(self):
        config = Configuration(Path(__file__).resolve().parent)
        descriptors = config.resources("google_monitoring_metric_descriptor")
        self.assertIn("portal_database_connections", descriptors)
        descriptor = descriptors["portal_database_connections"]
        self.assertEqual(descriptor.attrs["type"], "var.database_connection_utilization_metric_type")
        self.assertEqual(unquote(descriptor.attrs["metric_kind"]), "GAUGE")
        self.assertEqual(unquote(descriptor.attrs["value_type"]), "DOUBLE")
        self.assertEqual(unquote(descriptor.attrs["unit"]), "1")
        alert = config.resources("google_monitoring_alert_policy")["portal_database_saturation"]
        condition = alert.child("conditions").child("condition_threshold")
        self.assertIn("google_monitoring_metric_descriptor.portal_database_connections.type", condition.attrs["filter"])
        self.assertIn(r'resource.type=\"global\"', condition.attrs["filter"])


    def test_all_log_metric_alerts_select_the_emitting_cloud_run_resource(self):
        config = Configuration(Path(__file__).resolve().parent)
        locals_by_name = config.locals()
        event_entries = parse_body(locals_by_name["portal_log_alerts"].strip()[1:-1]).attrs
        log_metric = config.resources("google_logging_metric")["portal_alert"]
        event_alert = config.resources("google_monitoring_alert_policy")["portal_log_alert"]
        event_filter = event_alert.child("conditions").child("condition_threshold").attrs["filter"]
        self.assertIn(r'resource.type=\"${each.value.resource_type}\"', event_filter)
        self.assertIn(r'resource.type=\"${each.value.resource_type}\"', log_metric.attrs["filter"])
        self.assertIn("${each.value.filter}", log_metric.attrs["filter"])
        self.assertIn("retention-errors", event_entries)
        for name, raw_entry in event_entries.items():
            with self.subTest(event=name):
                entry = parse_body(raw_entry.strip()[1:-1])
                expected = "cloud_run_job" if name == "retention-errors" else "cloud_run_revision"
                self.assertEqual(unquote(entry.attrs.get("resource_type", "")), expected)
                self.assertNotIn("resource.type", entry.attrs["filter"])
                self.assertIn("jsonPayload.stage", entry.attrs["filter"])
        for name in ("portal_backlog", "portal_request_latency"):
            with self.subTest(alert=name):
                alert = config.resources("google_monitoring_alert_policy")[name]
                condition = alert.child("conditions").child("condition_threshold")
                self.assertIn(r'resource.type=\"cloud_run_revision\"', condition.attrs["filter"])
                self.assertIn("logging.googleapis.com/user/", condition.attrs["filter"])

    def test_bootstrap_shells_have_memory_supported_by_always_allocated_cpu(self):
        config = Configuration(Path(__file__).resolve().parent)
        services = config.resources("google_cloud_run_v2_service")
        self.assertTrue({"web", "probe"} <= services.keys())
        for name, service in services.items():
            with self.subTest(service=name):
                container = service.child("template").child("containers")
                resources = container.child("resources")
                memory = re.search(r'memory\s*=\s*"(\d+)(Mi|Gi)"', resources.attrs["limits"])
                self.assertIsNotNone(memory)
                mebibytes = int(memory[1]) * (1024 if memory[2] == "Gi" else 1)
                if resources.attrs.get("cpu_idle", "false") == "false":
                    self.assertGreaterEqual(mebibytes, 512)
                self.assertIn("template", service.child("lifecycle").attrs["ignore_changes"])


if __name__ == "__main__":
    unittest.main()
