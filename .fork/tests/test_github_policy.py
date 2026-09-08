"""Branch protection failures and additive setup, without real GitHub calls."""

import copy
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "github_policy", Path(__file__).parents[1] / "github_policy.py"
)
policy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(policy)

APP = "APP_actions_fixture"


def rule(**changes):
    return {
        "id": "RULE_fixture",
        "pattern": "saturn/main",
        "requiresStatusChecks": True,
        "requiresStrictStatusChecks": True,
        "isAdminEnforced": True,
        "allowsForcePushes": False,
        "allowsDeletions": False,
        "requiredStatusChecks": [{"context": "fork-verified", "app": {"id": APP}}],
        "requiredStatusCheckContexts": ["fork-verified"],
        "requiresApprovingReviews": True,
        "requiredApprovingReviewCount": 2,
        "requiresCodeOwnerReviews": True,
        "requiresCommitSignatures": True,
        "restrictsPushes": True,
        "lockBranch": True,
        "pushAllowances": {"nodes": [], "pageInfo": {"hasNextPage": False}},
        "reviewDismissalAllowances": {"nodes": [], "pageInfo": {"hasNextPage": False}},
        "bypassPullRequestAllowances": {
            "nodes": [],
            "pageInfo": {"hasNextPage": False},
        },
        "bypassForcePushAllowances": {"nodes": [], "pageInfo": {"hasNextPage": False}},
        **changes,
    }


class PlanTests(unittest.TestCase):
    def test_creation_requires_exact_branch_check_app_and_admin_enforcement(self):
        desired = policy.plan(None, "REPO_fixture", APP)
        self.assertEqual(desired["pattern"], "saturn/main")
        self.assertTrue(desired["requiresStrictStatusChecks"])
        self.assertTrue(desired["isAdminEnforced"])
        self.assertFalse(desired["allowsForcePushes"])
        self.assertFalse(desired["allowsDeletions"])
        self.assertEqual(
            desired["requiredStatusChecks"],
            [{"context": "fork-verified", "appId": APP}],
        )
        self.assertNotIn("requiresApprovingReviews", desired)

    def test_correct_rule_is_an_idempotent_noop(self):
        self.assertEqual(policy.plan(rule(), "REPO_fixture", APP), {})

    def test_weak_rule_keeps_other_checks_and_does_not_rewrite_reviews_or_restrictions(
        self,
    ):
        existing = rule(
            requiresStrictStatusChecks=False,
            requiredStatusChecks=[{"context": "old-test", "app": {"id": "APP_old"}}],
            requiredStatusCheckContexts=["old-test"],
        )
        original = copy.deepcopy(existing)
        desired = policy.plan(existing, "REPO_fixture", APP)
        self.assertIn(
            {"context": "old-test", "appId": "APP_old"}, desired["requiredStatusChecks"]
        )
        self.assertIn(
            {"context": "fork-verified", "appId": APP}, desired["requiredStatusChecks"]
        )
        self.assertEqual(existing, original)
        for key in [
            "requiresApprovingReviews",
            "requiredApprovingReviewCount",
            "requiresCodeOwnerReviews",
            "requiresCommitSignatures",
            "restrictsPushes",
            "lockBranch",
        ]:
            self.assertNotIn(key, desired)

    def test_missing_old_and_unbound_gate_contexts_are_not_a_pass(self):
        cases = [
            rule(requiredStatusChecks=[], requiredStatusCheckContexts=[]),
            rule(
                requiredStatusChecks=[{"context": "legacy-gate", "app": None}],
                requiredStatusCheckContexts=["legacy-gate"],
            ),
            rule(requiredStatusChecks=[{"context": "fork-verified", "app": None}]),
            rule(
                requiredStatusChecks=[
                    {"context": "fork-verified", "app": {"id": "APP_wrong"}}
                ]
            ),
        ]
        for current in cases:
            with self.subTest(current=current):
                self.assertTrue(policy.plan(current, "REPO_fixture", APP))

    def test_each_missing_mandatory_setting_requires_repair(self):
        for key, value in [
            ("requiresStatusChecks", False),
            ("requiresStrictStatusChecks", False),
            ("isAdminEnforced", False),
            ("allowsForcePushes", True),
            ("allowsDeletions", True),
        ]:
            with self.subTest(key=key):
                desired = policy.plan(rule(**{key: value}), "REPO_fixture", APP)
                self.assertEqual(desired[key], not value)

    def test_weak_wildcard_rule_is_never_changed_for_other_branches(self):
        with self.assertRaisesRegex(ValueError, "wildcard"):
            policy.plan(
                rule(pattern="saturn/*", isAdminEnforced=False), "REPO_fixture", APP
            )

    def test_force_push_allowances_are_removed_even_if_default_force_pushes_are_blocked(
        self,
    ):
        existing = rule(
            bypassForcePushAllowances={
                "nodes": [{"actor": {"id": "ACTOR_fixture"}}],
                "pageInfo": {"hasNextPage": False},
            }
        )
        desired = policy.plan(existing, "REPO_fixture", APP)
        self.assertEqual(desired["bypassForcePushActorIds"], [])

    def test_malformed_policy_is_not_replaced_with_defaults(self):
        for current in [
            {},
            rule(requiredStatusChecks="bad"),
            rule(isAdminEnforced=None),
            rule(requiredStatusChecks=[{"context": "old", "app": {}}]),
        ]:
            with self.subTest(current=current), self.assertRaises(ValueError):
                policy.plan(current, "REPO_fixture", APP)


def repository(current):
    return {
        "data": {
            "repository": {
                "id": "REPO_fixture",
                "nameWithOwner": "example/carbon",
                "viewerPermission": "ADMIN",
                "ref": {
                    "name": "saturn/main",
                    "prefix": "refs/heads/",
                    "branchProtectionRule": current,
                },
            }
        }
    }


class ExecutionTests(unittest.TestCase):
    def invoke(self, responses, *arguments):
        with patch.object(
            policy, "gh_api", side_effect=responses
        ) as api, redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            result = policy.main(["--repo", "example/carbon", *arguments])
        return result, api

    def test_default_missing_protection_fails_without_mutation(self):
        result, api = self.invoke(
            [{"node_id": APP, "slug": "github-actions"}, repository(None)]
        )
        self.assertEqual(result, 1)
        self.assertTrue(
            all(
                "mutation" not in (call.kwargs.get("payload") or {}).get("query", "")
                for call in api.call_args_list
            )
        )

    def test_explicit_apply_adds_only_policy_fields_and_verifies_remote_state(self):
        current = rule(isAdminEnforced=False)
        result, api = self.invoke(
            [
                {"node_id": APP, "slug": "github-actions"},
                repository(current),
                repository(current),
                {
                    "data": {
                        "updateBranchProtectionRule": {
                            "branchProtectionRule": {"id": "RULE_fixture"}
                        }
                    }
                },
                repository(rule()),
            ],
            "--apply",
        )
        self.assertEqual(result, 0)
        mutation = api.call_args_list[3].kwargs["payload"]
        self.assertEqual(
            mutation["variables"]["input"],
            {"branchProtectionRuleId": "RULE_fixture", "isAdminEnforced": True},
        )

    def test_apply_refuses_policy_that_changed_during_preparation(self):
        result, api = self.invoke(
            [
                {"node_id": APP, "slug": "github-actions"},
                repository(rule(isAdminEnforced=False)),
                repository(rule(isAdminEnforced=False, requiredApprovingReviewCount=3)),
            ],
            "--apply",
        )
        self.assertEqual(result, 1)
        self.assertEqual(api.call_count, 3)

    def test_remote_apply_failure_and_missing_branch_are_not_success(self):
        for response in [
            repository(None) | {"errors": [{"message": "sensitive provider response"}]},
            {
                "data": {
                    "repository": {
                        "id": "REPO_fixture",
                        "nameWithOwner": "example/carbon",
                        "ref": None,
                    }
                }
            },
        ]:
            result, _ = self.invoke(
                [{"node_id": APP, "slug": "github-actions"}, response]
            )
            self.assertEqual(result, 1)

    def test_apply_api_failure_is_never_reported_as_success(self):
        current = rule(isAdminEnforced=False)
        result, _ = self.invoke(
            [
                {"node_id": APP, "slug": "github-actions"},
                repository(current),
                repository(current),
                {"errors": [{"message": "private provider response"}]},
            ],
            "--apply",
        )
        self.assertEqual(result, 1)

    def test_changed_reviews_or_missing_gate_after_apply_remain_failed(self):
        current = rule(isAdminEnforced=False)
        for changed in [rule(requiredApprovingReviewCount=0), current]:
            result, _ = self.invoke(
                [
                    {"node_id": APP, "slug": "github-actions"},
                    repository(current),
                    repository(current),
                    {
                        "data": {
                            "updateBranchProtectionRule": {
                                "branchProtectionRule": {"id": "RULE_fixture"}
                            }
                        }
                    },
                    repository(changed),
                ],
                "--apply",
            )
            self.assertEqual(result, 1)

    def test_read_only_mode_accepts_complete_policy_without_writes(self):
        result, api = self.invoke(
            [{"node_id": APP, "slug": "github-actions"}, repository(rule())], "--check"
        )
        self.assertEqual(result, 0)
        self.assertEqual(api.call_count, 2)

    def test_wrong_repository_or_branch_is_rejected(self):
        for key, value in [("name", "main"), ("prefix", "refs/tags/")]:
            response = repository(rule())
            response["data"]["repository"]["ref"][key] = value
            result, _ = self.invoke(
                [{"node_id": APP, "slug": "github-actions"}, response]
            )
            self.assertEqual(result, 1)

    def test_gh_uses_structured_stdin_and_sanitizes_failed_auth_and_404(self):
        payload = {
            "query": "query Fixture($name: String!) { __typename }",
            "variables": {"name": "example"},
        }
        result = subprocess.CompletedProcess([], 0, stdout='{"data": {}}', stderr="")
        with patch.object(policy.subprocess, "run", return_value=result) as run:
            policy.gh_api("graphql", payload=payload)
        self.assertEqual(json.loads(run.call_args.kwargs["input"]), payload)
        self.assertIn("--input", run.call_args.args[0])
        self.assertIn("github.com", run.call_args.args[0])
        for message in ["gh: not found (HTTP 404) sensitive", "auth token sensitive"]:
            with patch.object(
                policy.subprocess,
                "run",
                return_value=subprocess.CompletedProcess(
                    [], 1, stdout="private", stderr=message
                ),
            ):
                with self.assertRaises(ValueError) as failure:
                    policy.gh_api("graphql", payload=payload)
                self.assertNotIn("sensitive", str(failure.exception))


if __name__ == "__main__":
    unittest.main()
