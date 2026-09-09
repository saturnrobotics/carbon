"""Exact-revision release evidence tests; all GitHub responses are synthetic."""

import copy
import io
import unittest
import urllib.error
from unittest.mock import patch

import verify_source


REVISION = "a" * 40
SOURCE = "https://github.com/example/carbon"
BRANCH = "sync/upstream-example"


def workflow_run(**changes):
    return {
        "id": 31,
        "run_number": 4,
        "run_attempt": 1,
        "head_sha": REVISION,
        "head_branch": BRANCH,
        "head_repository": {"full_name": "example/carbon"},
        "repository": {"full_name": "example/carbon"},
        "path": ".github/workflows/fork-check.yml",
        "event": "push",
        "status": "completed",
        "conclusion": "success",
        **changes,
    }


def gate_job(**changes):
    return {
        "id": 51,
        "run_id": 31,
        "head_sha": REVISION,
        "name": "fork-verified",
        "status": "completed",
        "conclusion": "success",
        **changes,
    }


class VerificationTests(unittest.TestCase):
    def check(self, runs=None, jobs=None, *, branch=BRANCH):
        runs = [workflow_run()] if runs is None else runs
        jobs = [gate_job()] if jobs is None else jobs
        with patch.object(
            verify_source,
            "github_json",
            side_effect=[
                {"total_count": len(runs), "workflow_runs": runs},
                {"total_count": len(jobs), "jobs": jobs},
            ],
        ) as api:
            receipt = verify_source.require_verified(SOURCE, REVISION, branch=branch)
        return receipt, api

    def test_accepts_successful_exact_revision_and_specific_attempt_gate(self):
        receipt, api = self.check()
        self.assertEqual(receipt["revision"], REVISION)
        self.assertEqual(receipt["run_id"], 31)
        self.assertIn("/workflows/fork-check.yml/runs?", api.call_args_list[0].args[0])
        self.assertIn("head_sha=" + REVISION, api.call_args_list[0].args[0])
        self.assertIn("branch=sync%2Fupstream-example", api.call_args_list[0].args[0])
        self.assertIn("/runs/31/attempts/1/jobs?", api.call_args_list[1].args[0])

    def test_deploy_can_use_verified_candidate_without_publishing_stable_first(self):
        receipt, api = self.check(branch=None)
        self.assertEqual(receipt["revision"], REVISION)
        self.assertNotIn("branch=", api.call_args_list[0].args[0])

    def test_missing_and_non_successful_runs_fail_closed(self):
        with self.assertRaisesRegex(ValueError, "Fork verification"):
            self.check(runs=[])
        for conclusion in [
            None,
            "failure",
            "skipped",
            "neutral",
            "cancelled",
            "timed_out",
        ]:
            with self.subTest(conclusion=conclusion), self.assertRaisesRegex(
                ValueError, "Fork verification"
            ):
                self.check(runs=[workflow_run(conclusion=conclusion)])
        for status in ["queued", "in_progress", "waiting", "pending", None]:
            with self.subTest(status=status), self.assertRaisesRegex(
                ValueError, "Fork verification"
            ):
                self.check(runs=[workflow_run(status=status)])

    def test_missing_and_unfinished_runs_are_distinct_pending_results(self):
        for runs in (
            [],
            [workflow_run(status="queued", conclusion=None)],
            [workflow_run(status="in_progress", conclusion=None)],
            [
                workflow_run(),
                workflow_run(id=32, run_number=5, status="waiting", conclusion=None),
            ],
        ):
            with self.subTest(runs=runs), self.assertRaises(ValueError) as failure:
                self.check(runs=runs)
            self.assertIs(
                type(failure.exception),
                getattr(verify_source, "VerificationPending", None),
            )

    def test_completed_unsuccessful_run_identifies_the_validated_latest_run(self):
        for conclusion in (None, "failure", "skipped", "cancelled", "timed_out"):
            with self.subTest(conclusion=conclusion), self.assertRaises(
                ValueError
            ) as failure:
                self.check(
                    runs=[
                        workflow_run(),
                        workflow_run(id=32, run_number=5, conclusion=conclusion),
                    ]
                )
            self.assertIs(
                type(failure.exception),
                getattr(verify_source, "VerificationFailed", None),
            )
            self.assertEqual(failure.exception.run_id, 32)

    def test_invalid_run_identity_is_neither_pending_nor_repairable_failure(self):
        for identifier in (True, 0, -1, "31", "untrusted/path"):
            for status in ("queued", "completed"):
                with self.subTest(identifier=identifier, status=status):
                    with self.assertRaises(ValueError) as failure:
                        self.check(
                            runs=[
                                workflow_run(
                                    id=identifier, status=status, conclusion="failure"
                                )
                            ]
                        )
                    self.assertIs(type(failure.exception), ValueError)

    def test_failed_exception_rejects_unvalidated_identifiers(self):
        exception_type = getattr(verify_source, "VerificationFailed", None)
        self.assertIsNotNone(exception_type)
        for identifier in (True, 0, -1, "31", None):
            with self.subTest(identifier=identifier), self.assertRaises(ValueError):
                exception_type("Fork verification failed", run_id=identifier)

    def test_wrong_revision_branch_repository_workflow_and_event_are_rejected(self):
        for changes in [
            {"head_sha": "b" * 40},
            {"head_branch": "sync/other"},
            {"head_repository": {"full_name": "other/carbon"}},
            {"repository": {"full_name": "other/carbon"}},
            {"path": ".github/workflows/unrelated.yml"},
            {"event": "pull_request_target"},
            {"id": "untrusted/path"},
            {"run_attempt": None},
            {"head_repository": None},
            {"repository": {"full_name": None}},
        ]:
            with self.subTest(changes=changes), self.assertRaisesRegex(
                ValueError, "Fork verification"
            ):
                self.check(runs=[workflow_run(**changes)])

    def test_latest_pending_run_cannot_fall_back_to_older_success(self):
        with self.assertRaisesRegex(ValueError, "Fork verification"):
            self.check(
                runs=[
                    workflow_run(),
                    workflow_run(id=32, run_number=5, status="queued", conclusion=None),
                ]
            )

    def test_rerun_checks_its_own_attempt_and_dispatch_is_supported(self):
        receipt, api = self.check(
            runs=[workflow_run(run_attempt=2, event="workflow_dispatch")]
        )
        self.assertEqual(receipt["run_attempt"], 2)
        self.assertIn("/runs/31/attempts/2/jobs?", api.call_args_list[1].args[0])

    def test_paginated_evidence_does_not_stop_before_a_later_failure(self):
        with patch.object(
            verify_source,
            "github_json",
            side_effect=[
                {"total_count": 2, "workflow_runs": [workflow_run()]},
                {
                    "total_count": 2,
                    "workflow_runs": [
                        workflow_run(id=32, run_number=5, conclusion="failure")
                    ],
                },
            ],
        ) as api:
            with self.assertRaisesRegex(ValueError, "Fork verification"):
                verify_source.require_verified(SOURCE, REVISION)
        self.assertIn("page=2", api.call_args_list[1].args[0])

    def test_required_final_job_cannot_be_missing_skipped_stale_or_duplicated(self):
        cases = [
            [],
            [gate_job(name="other")],
            [gate_job(conclusion="skipped")],
            [gate_job(status="in_progress")],
            [gate_job(head_sha="b" * 40)],
            [gate_job(run_id=30)],
            [gate_job(), gate_job(id=52)],
        ]
        for jobs in cases:
            with self.subTest(jobs=jobs), self.assertRaisesRegex(
                ValueError, "Fork verification"
            ):
                self.check(jobs=jobs)

    def test_pull_request_must_target_integration_branch_at_same_revision(self):
        request = {
            "base": {
                "ref": "saturn/main",
                "repo": {
                    "name": "carbon",
                    "url": "https://api.github.com/repos/example/carbon",
                },
            },
            "head": {"sha": REVISION},
        }
        receipt, _ = self.check(
            runs=[workflow_run(event="pull_request", pull_requests=[request])]
        )
        self.assertEqual(receipt["revision"], REVISION)
        for request_change in [{"base": {"ref": "main"}}, {"head": {"sha": "b" * 40}}]:
            invalid = {**copy.deepcopy(request), **request_change}
            with self.subTest(request_change=request_change), self.assertRaisesRegex(
                ValueError, "Fork verification"
            ):
                self.check(
                    runs=[workflow_run(event="pull_request", pull_requests=[invalid])]
                )

    def test_invalid_remote_and_revision_do_not_call_api(self):
        for source, revision in [
            ("https://github.com/user:secret/carbon", REVISION),
            ("https://example.com/example/carbon", REVISION),
            (SOURCE, "HEAD;anything"),
            (SOURCE, "a" * 7),
        ]:
            with self.subTest(source=source, revision=revision), patch.object(
                verify_source, "github_json"
            ) as api:
                with self.assertRaises(ValueError):
                    verify_source.require_verified(source, revision)
                api.assert_not_called()

    def test_malformed_and_incomplete_api_response_is_not_success(self):
        for response in [
            {},
            [],
            {"total_count": 2, "workflow_runs": []},
            {"total_count": 1, "workflow_runs": "bad"},
        ]:
            with self.subTest(response=response), patch.object(
                verify_source, "github_json", return_value=response
            ):
                with self.assertRaisesRegex(ValueError, "Fork verification"):
                    verify_source.require_verified(SOURCE, REVISION)

    def test_api_errors_do_not_echo_provider_response_body(self):
        error = urllib.error.HTTPError(
            "https://api.github.com/example",
            403,
            "private provider detail",
            {},
            io.BytesIO(b"private body"),
        )
        with patch.object(verify_source.urllib.request, "urlopen", side_effect=error):
            with self.assertRaisesRegex(ValueError, "HTTP 403") as failure:
                verify_source.github_json("/repos/example/carbon/actions/runs")
        self.assertNotIn("private", str(failure.exception))


if __name__ == "__main__":
    unittest.main()
