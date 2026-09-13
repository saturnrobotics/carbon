"""Cloud Scheduler configuration and authenticated activation contracts."""
from datetime import datetime, timezone
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from test_deploy import module
from test_deploy_preflight import configuration, ProviderReads
from test_release import database_plan, foundation_outputs, FIRST, LAST

NOW = datetime(2026, 9, 13, 12, 0, tzinfo=timezone.utc)
ATTEMPT = "2026-09-13T12:00:01Z"


def execution_log(job, phase, *, timestamp=ATTEMPT, status=200, suffix=""):
    payload = {"@type": "type.googleapis.com/google.cloud.scheduler.logging.Attempt" + phase,
               "jobName": job, "url": scheduler_outputs()["outbox_scheduler"]["value"]["audience"] + "/internal/outbox/" + job.rsplit("-", 1)[-1], "targetType": "HTTP"}
    return {"insertId": phase + suffix, "timestamp": timestamp, "jsonPayload": payload,
            "httpRequest": {"status": status} if phase == "Finished" else {}}


class SchedulerAdapter:
    def __init__(self, *, logs=None, drain_state="PAUSED"):
        self.scheduler = scheduler_outputs()["outbox_scheduler"]["value"]
        self.calls = []
        self.jobs = {}
        for kind in ("drain", "check"):
            name = self.scheduler[kind + "_job"]
            self.jobs[name] = {"name": name, "state": drain_state if kind == "drain" else "PAUSED",
                               "schedule": "* * * * *", "timeZone": "Etc/UTC", "attemptDeadline": "450s", "retryConfig": {},
                               "httpTarget": {"uri": self.scheduler["audience"] + "/internal/outbox/" + kind, "httpMethod": "POST",
                                              "oidcToken": {"serviceAccountEmail": self.scheduler["service_account"], "audience": self.scheduler["audience"]}}}
        job = self.scheduler["check_job"]
        self.logs = logs if logs is not None else [[execution_log(job, "Started"), execution_log(job, "Finished", timestamp="2026-09-13T12:00:02Z")]]

    def call(self, args, *, capture=False):
        self.calls.append(args)
        if args[:3] == ["gcloud", "iam", "service-accounts"]:
            return json.dumps({"email": self.scheduler["service_account"], "uniqueId": self.scheduler["subject"], "disabled": False})
        if args[:3] == ["gcloud", "logging", "read"]:
            result = self.logs.pop(0) if len(self.logs) > 1 else self.logs[0]
            return json.dumps(result)
        if args[:3] == ["gcloud", "scheduler", "jobs"]:
            action, name = args[3:5]
            if action == "run":
                self.jobs[name]["lastAttemptTime"] = ATTEMPT
                self.jobs[name]["status"] = {}
            if action in {"resume", "pause"}:
                self.jobs[name]["state"] = "ENABLED" if action == "resume" else "PAUSED"
            return json.dumps(self.jobs[name])
        raise AssertionError("Unexpected provider command")


def scheduler_outputs():
    outputs = foundation_outputs()
    outputs["database_connection_utilization_metric_type"] = {"value": "custom.googleapis.com/portal/database_connection_utilization"}
    outputs["outbox_scheduler"] = {"value": {
        "service_account": "portal-scheduler@example-project.iam.gserviceaccount.com",
        "subject": "123456789012345678901",
        "audience": "https://portal-ingest-123456789.us-east1.run.app",
        "drain_job": "projects/example-project/locations/us-east1/jobs/portal-outbox-drain",
        "check_job": "projects/example-project/locations/us-east1/jobs/portal-outbox-check",
    }}
    return outputs


def scheduler_config(deploy):
    config = configuration(deploy)
    ingest = config["services"]["portal-ingest"]
    ingest["environment"]["PORTAL_SCHEDULER_MODE"] = "cloud-scheduler"
    ingest["secrets"].pop("INNGEST_SIGNING_KEY")
    return config


class SchedulerConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.deploy = module()

    def candidate(self):
        return self.deploy.prepare_plan(scheduler_config(self.deploy), "a" * 40, scheduler_outputs(), [FIRST, LAST])

    def test_cloud_scheduler_mode_uses_foundation_identity_and_no_inngest_secret(self):
        candidate = self.candidate()
        spec = candidate["services"]["portal-ingest"]
        self.assertEqual(spec["environment"]["PORTAL_SCHEDULER_SUBJECT"], "123456789012345678901")
        self.assertEqual(spec["environment"]["PORTAL_SCHEDULER_AUDIENCE"], scheduler_outputs()["outbox_scheduler"]["value"]["audience"])
        self.assertNotIn("INNGEST_SIGNING_KEY", spec["secrets"])
        document = self.deploy.release.revision_document("portal-ingest", spec, "digest")
        self.assertEqual(document["spec"]["template"]["spec"]["timeoutSeconds"], 420)

    def test_legacy_inngest_mode_still_requires_its_key(self):
        candidate = database_plan("portal-ingest")
        self.deploy.release.validate_plan(candidate)
        candidate["services"]["portal-ingest"]["secrets"].pop("INNGEST_SIGNING_KEY")
        with self.assertRaisesRegex(ValueError, "missing mandatory.*INNGEST_SIGNING_KEY"):
            self.deploy.release.validate_plan(candidate)

    def test_scheduler_identity_drift_and_missing_foundation_fail_closed(self):
        config = scheduler_config(self.deploy)
        config["services"]["portal-ingest"]["environment"]["PORTAL_SCHEDULER_SUBJECT"] = "999999999999999999999"
        with self.assertRaisesRegex(ValueError, "scheduler.*differs"):
            self.deploy.prepare_plan(config, "a" * 40, scheduler_outputs(), [FIRST, LAST])
        with self.assertRaisesRegex(ValueError, "outbox_scheduler"):
            self.deploy.prepare_plan(scheduler_config(self.deploy), "a" * 40, foundation_outputs(), [FIRST, LAST])

    def test_invalid_or_mixed_scheduler_modes_cannot_be_released(self):
        for invalid in ({"PORTAL_SCHEDULER_MODE": "unknown"}, {"PORTAL_SCHEDULER_SUBJECT": "user@example.com"}, {"PORTAL_SCHEDULER_AUDIENCE": "http://example.com"}, {"PORTAL_RELEASE_PROFILE": "connected"}):
            with self.subTest(invalid=invalid):
                candidate = self.candidate()
                candidate["services"]["portal-ingest"]["environment"].update(invalid)
                with self.assertRaises(ValueError):
                    self.deploy.release.validate_plan(candidate)
        candidate = self.candidate()
        candidate["services"]["portal-ingest"]["secrets"]["INNGEST_SIGNING_KEY"] = "projects/example-project/secrets/inngest/versions/1"
        with self.assertRaisesRegex(ValueError, "INNGEST_SIGNING_KEY"):
            self.deploy.release.validate_plan(candidate)
        legacy = database_plan("portal-ingest")
        legacy["services"]["portal-ingest"]["environment"]["PORTAL_SCHEDULER_SUBJECT"] = "123456789012345678901"
        with self.assertRaisesRegex(ValueError, "scheduler"):
            self.deploy.release.validate_plan(legacy)


class SchedulerActivationTests(unittest.TestCase):
    def setUp(self):
        self.deploy = module()
        self.scheduler = scheduler_outputs()["outbox_scheduler"]["value"]

    def activate(self, adapter):
        self.assertTrue(callable(getattr(self.deploy, "activate_scheduler", None)), "Missing authenticated scheduler readiness gate")
        return self.deploy.activate_scheduler(self.scheduler, adapter, verify_revision=lambda: None,
                                              maximum_polls=3, wait=lambda _: None, now=lambda: NOW)

    def test_resume_follows_fresh_authenticated_completion_not_dispatch_or_stale_success(self):
        job = self.scheduler["check_job"]
        logs = [[execution_log(job, "Started")], [execution_log(job, "Started"), execution_log(job, "Finished", timestamp="2026-09-13T12:00:02Z")]]
        adapter = SchedulerAdapter(logs=logs)
        receipt = self.activate(adapter)
        actions = [args[3] for args in adapter.calls if args[:3] == ["gcloud", "scheduler", "jobs"]]
        self.assertIn("run", actions)
        self.assertEqual(actions[-2:], ["resume", "describe"])
        self.assertEqual(len([args for args in adapter.calls if args[:3] == ["gcloud", "logging", "read"]]), 2)
        self.assertEqual(receipt["last_attempt_time"], ATTEMPT)
        self.assertEqual(adapter.jobs[job]["state"], "PAUSED")

    def test_failed_absent_stale_or_ambiguous_completion_never_resumes_drain(self):
        job = self.scheduler["check_job"]
        started = execution_log(job, "Started")
        finished = execution_log(job, "Finished", timestamp="2026-09-13T12:00:02Z")
        cases = [[], [started], [started, execution_log(job, "Finished", timestamp="2026-09-13T12:00:02Z", status=403)],
                 [execution_log(job, "Started", timestamp="2026-09-12T12:00:01Z"), execution_log(job, "Finished", timestamp="2026-09-12T12:00:02Z")],
                 [started, finished, execution_log(job, "Started", suffix="concurrent")],
                 [started, {**finished, "jsonPayload": {**finished["jsonPayload"], "url": "https://other.example/health"}}]]
        for logs in cases:
            with self.subTest(logs=logs):
                adapter = SchedulerAdapter(logs=[logs])
                with self.assertRaises(ValueError):
                    self.activate(adapter)
                self.assertFalse(any(args[:4] == ["gcloud", "scheduler", "jobs", "resume"] for args in adapter.calls))

    def test_enabled_check_job_is_refused_instead_of_running_concurrently(self):
        adapter = SchedulerAdapter()
        adapter.jobs[self.scheduler["check_job"]]["state"] = "ENABLED"
        with self.assertRaisesRegex(ValueError, "check.*paused"):
            self.activate(adapter)
        self.assertFalse(any(args[:4] == ["gcloud", "scheduler", "jobs", "run"] for args in adapter.calls))

    def test_foundation_identity_and_jobs_are_read_before_any_mutation(self):
        self.assertTrue(callable(getattr(self.deploy, "observe_scheduler", None)), "Missing scheduler foundation preflight")
        adapter = SchedulerAdapter()
        config = scheduler_config(self.deploy)
        candidate = self.deploy.prepare_plan(config, "a" * 40, scheduler_outputs(), [FIRST, LAST])
        observed = self.deploy.observe_scheduler(config, candidate, scheduler_outputs(), adapter)
        self.assertEqual(observed, self.scheduler)
        self.assertTrue(any(args[:3] == ["gcloud", "logging", "read"] for args in adapter.calls), "Log access must be checked before long image builds")
        self.assertFalse(any("run" in args or "resume" in args or "pause" in args for args in adapter.calls))
        for field in ("uri", "httpMethod", "oidcToken", "body"):
            bad = SchedulerAdapter()
            bad.jobs[self.scheduler["drain_job"]]["httpTarget"][field] = "invalid"
            with self.assertRaisesRegex(ValueError, "scheduler.*drift"):
                self.deploy.observe_scheduler(config, candidate, scheduler_outputs(), bad)

    def test_pause_stops_new_drain_attempts_and_waits_for_existing_work(self):
        self.assertTrue(callable(getattr(self.deploy, "pause_scheduler", None)), "Missing scheduler pause gate")
        adapter = SchedulerAdapter(drain_state="ENABLED")
        job = self.scheduler["drain_job"]
        adapter.jobs[job]["lastAttemptTime"] = ATTEMPT
        adapter.logs = [[execution_log(job, "Started")], [execution_log(job, "Started"), execution_log(job, "Finished", timestamp="2026-09-13T12:00:02Z")]]
        self.deploy.pause_scheduler(self.scheduler, adapter, maximum_polls=3, wait=lambda _: None, now=lambda: NOW)
        self.assertEqual(adapter.jobs[job]["state"], "PAUSED")
        self.assertEqual(len([args for args in adapter.calls if args[:3] == ["gcloud", "logging", "read"]]), 2)

    def test_missing_prior_completion_blocks_another_forced_check(self):
        adapter = SchedulerAdapter(logs=[[]])
        adapter.jobs[self.scheduler["check_job"]]["lastAttemptTime"] = "2026-09-13T11:59:00Z"
        with self.assertRaisesRegex(ValueError, "completion was not proven"):
            self.activate(adapter)
        self.assertFalse(any(args[:4] == ["gcloud", "scheduler", "jobs", "run"] for args in adapter.calls))

    def test_expired_historic_logs_do_not_block_a_new_authenticated_check(self):
        adapter = SchedulerAdapter()
        adapter.jobs[self.scheduler["check_job"]]["lastAttemptTime"] = "2026-08-01T00:00:00Z"
        self.activate(adapter)
        self.assertEqual(adapter.jobs[self.scheduler["drain_job"]]["state"], "ENABLED")
        self.assertEqual(len([args for args in adapter.calls if args[:3] == ["gcloud", "logging", "read"]]), 1)

    def test_actual_ingest_traffic_must_match_the_manifest_not_only_the_template(self):
        self.assertTrue(callable(getattr(self.deploy, "require_scheduler_revision", None)), "Missing served-revision proof")
        candidate = self.deploy.prepare_plan(scheduler_config(self.deploy), "a" * 40, scheduler_outputs(), [FIRST, LAST])
        digest = self.deploy.release.revision_digest(candidate["services"]["portal-ingest"])
        observed = {"spec": {"template": {"metadata": {"labels": {self.deploy.release.DIGEST_LABEL: self.deploy.release.digest_label(digest)}}}},
                    "status": {"latestReadyRevisionName": "ingest-reviewed", "latestCreatedRevisionName": "ingest-reviewed",
                               "conditions": [{"type": "Ready", "status": "True"}],
                               "traffic": [{"revisionName": "ingest-reviewed", "percent": 100}]}}
        class Adapter:
            def call(self, args, *, capture=False):
                return json.dumps(observed)
        with tempfile.TemporaryDirectory() as directory:
            manifest = Path(directory) / "release-manifest.json"
            manifest.write_text(json.dumps({"services": {"portal-ingest": {"revision_digest": digest, "deployed_revision": "ingest-reviewed"}}}))
            args = (candidate, manifest, {"project": "example-project", "region": "us-east1"}, Adapter())
            self.deploy.require_scheduler_revision(*args)
            for traffic in ([{"revisionName": "ingest-old", "percent": 100}],
                            [{"revisionName": "ingest-reviewed", "percent": 90}, {"revisionName": "ingest-old", "percent": 10}], []):
                with self.subTest(traffic=traffic):
                    observed["status"]["traffic"] = traffic
                    with self.assertRaisesRegex(ValueError, "reviewed ingest revision"):
                        self.deploy.require_scheduler_revision(*args)

    def test_traffic_drift_during_check_prevents_scheduler_resume(self):
        adapter = SchedulerAdapter()
        calls = []
        def verify():
            calls.append(True)
            if len(calls) == 2:
                raise ValueError("reviewed ingest revision drift")
        with self.assertRaisesRegex(ValueError, "reviewed ingest revision"):
            self.deploy.activate_scheduler(self.scheduler, adapter, verify_revision=verify,
                                          maximum_polls=3, wait=lambda _: None, now=lambda: NOW)
        self.assertFalse(any(args[:4] == ["gcloud", "scheduler", "jobs", "resume"] for args in adapter.calls))


class SchedulerOrchestrationTests(unittest.TestCase):
    def exercise(self, *, apply=True, release_failure=False):
        deploy = module()
        scheduler = scheduler_outputs()["outbox_scheduler"]["value"]
        events = []
        class Reads(ProviderReads):
            def call(self, args, *, capture=False):
                if args[0] == "terraform":
                    return json.dumps(scheduler_outputs())
                return super().call(args, capture=capture)
        def release_units(*args, **kwargs):
            events.append("release")
            if release_failure:
                raise ValueError("synthetic release failure")
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(deploy, "source_revision", return_value="a" * 40), \
             patch.object(deploy, "observe_scheduler", return_value=scheduler), \
             patch.object(deploy, "archive_source"), \
             patch.object(deploy, "build_images", side_effect=lambda *args: events.append("build")), \
             patch.object(deploy, "pause_scheduler", side_effect=lambda *args: events.append("pause")), \
             patch.object(deploy, "release_units", side_effect=release_units), \
             patch.object(deploy, "activate_scheduler", side_effect=lambda *args, **kwargs: events.append("check-and-resume") or {"last_attempt_time": ATTEMPT}):
            state = Path(directory)
            if release_failure:
                with self.assertRaisesRegex(ValueError, "synthetic release failure"):
                    deploy.orchestrate(scheduler_config(deploy), state, apply=apply, adapter=Reads())
            else:
                deploy.orchestrate(scheduler_config(deploy), state, apply=apply, adapter=Reads())
            self.assertEqual((state / "scheduler-readiness.json").exists(), apply and not release_failure)
        return events

    def test_apply_pauses_before_any_release_and_only_activates_after_success(self):
        self.assertEqual(self.exercise(), ["build", "pause", "release", "check-and-resume"])
        self.assertEqual(self.exercise(release_failure=True), ["build", "pause", "release"])

    def test_read_only_check_never_forces_a_scheduler_attempt(self):
        self.assertEqual(self.exercise(apply=False), [])


if __name__ == "__main__":
    unittest.main()
