"""Inspect GitHub branch protection; only --apply may strengthen remote policy.

Updates use GraphQL's selective fields, preserving existing review requirements,
signatures, push restrictions, locks and rulesets. No branch contents are changed.
"""

import argparse
import json
import re
import subprocess
import sys


BRANCH = "saturn/main"
CONTEXT = "fork-verified"
REQUIRED = {
    "requiresStatusChecks": True,
    "requiresStrictStatusChecks": True,
    "isAdminEnforced": True,
    "allowsForcePushes": False,
    "allowsDeletions": False,
}
QUERY = """query ForkProtection($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    id nameWithOwner viewerPermission
    ref(qualifiedName: "refs/heads/saturn/main") {
      name prefix
      branchProtectionRule {
        id pattern requiresStatusChecks requiresStrictStatusChecks isAdminEnforced
        allowsForcePushes allowsDeletions requiredStatusCheckContexts
        requiredStatusChecks { context app { id } }
        requiresApprovingReviews requiredApprovingReviewCount requiresCodeOwnerReviews
        dismissesStaleReviews requireLastPushApproval requiresCommitSignatures
        requiresConversationResolution requiresLinearHistory restrictsPushes
        restrictsReviewDismissals requiresDeployments requiredDeploymentEnvironments
        lockBranch lockAllowsFetchAndMerge blocksCreations
        pushAllowances(first: 100) { nodes { actor { ... on User { id } ... on Team { id } ... on App { id } } } pageInfo { hasNextPage } }
        reviewDismissalAllowances(first: 100) { nodes { actor { ... on User { id } ... on Team { id } ... on App { id } } } pageInfo { hasNextPage } }
        bypassPullRequestAllowances(first: 100) { nodes { actor { ... on User { id } ... on Team { id } ... on App { id } } } pageInfo { hasNextPage } }
        bypassForcePushAllowances(first: 100) { nodes { actor { ... on User { id } ... on Team { id } ... on App { id } } } pageInfo { hasNextPage } }
      }
    }
  }
}"""


def gh_api(path, *, payload=None):
    command = [
        "gh",
        "api",
        "--hostname",
        "github.com",
        "--method",
        "POST" if payload else "GET",
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        "X-GitHub-Api-Version: 2022-11-28",
        path,
    ]
    if payload is not None:
        command += ["--input", "-"]
    try:
        response = subprocess.run(
            command,
            input=json.dumps(payload) if payload is not None else None,
            text=True,
            capture_output=True,
            check=False,
            timeout=45,
        )
    except FileNotFoundError:
        raise ValueError(
            "GitHub CLI is missing; install gh and authenticate with gh auth login"
        ) from None
    except (OSError, subprocess.TimeoutExpired):
        raise ValueError(
            "GitHub policy inspection did not complete; check access and retry"
        ) from None
    if response.returncode:
        status = re.search(r"HTTP (\d{3})", response.stderr)
        if status:
            raise ValueError(
                f"GitHub policy API HTTP {status.group(1)}; check repository/branch availability and Administration permissions"
            )
        raise ValueError(
            "GitHub policy API failed; authenticate with gh auth login and check repository permissions"
        )
    try:
        value = json.loads(response.stdout)
    except (ValueError, TypeError):
        raise ValueError("GitHub policy API returned malformed JSON") from None
    if not isinstance(value, dict) or value.get("errors"):
        raise ValueError(
            "GitHub policy API returned errors; verify authentication and Administration permissions"
        )
    return value


def checks(rule):
    values = rule.get("requiredStatusChecks")
    contexts = rule.get("requiredStatusCheckContexts")
    if values is None and rule.get("requiresStatusChecks") is False:
        values = []
    if contexts is None and rule.get("requiresStatusChecks") is False:
        contexts = []
    if not isinstance(values, list) or not isinstance(contexts, list):
        raise ValueError("Existing required-check policy is malformed; no changes made")
    result = []
    for value in values:
        if (
            not isinstance(value, dict)
            or not isinstance(value.get("context"), str)
            or not value["context"]
        ):
            raise ValueError(
                "Existing required-check context is malformed; no changes made"
            )
        app = value.get("app")
        if app is not None and (
            not isinstance(app, dict)
            or not isinstance(app.get("id"), str)
            or not app["id"]
        ):
            raise ValueError(
                "Existing required-check app binding is malformed; no changes made"
            )
        result.append(
            {"context": value["context"], "appId": app["id"] if app else "any"}
        )
    if any(not isinstance(context, str) or not context for context in contexts):
        raise ValueError(
            "Existing legacy status contexts are malformed; no changes made"
        )
    if set(contexts) != {value["context"] for value in result}:
        raise ValueError(
            "Existing status contexts have incomplete app bindings; review them before setup"
        )
    return result


def plan(rule, repository_id, app_id):
    """Return only fields that strengthen this branch; retain unrelated settings."""
    required_check = {"context": CONTEXT, "appId": app_id}
    if rule is None:
        return {
            "repositoryId": repository_id,
            "pattern": BRANCH,
            **REQUIRED,
            "requiredStatusChecks": [required_check],
            "bypassForcePushActorIds": [],
        }
    if (
        not isinstance(rule, dict)
        or not isinstance(rule.get("id"), str)
        or not rule["id"]
        or not isinstance(rule.get("pattern"), str)
        or any(not isinstance(rule.get(key), bool) for key in REQUIRED)
    ):
        raise ValueError("Existing branch protection is malformed; no changes made")
    for key in (
        "pushAllowances",
        "reviewDismissalAllowances",
        "bypassPullRequestAllowances",
        "bypassForcePushAllowances",
    ):
        if (
            not isinstance(rule.get(key), dict)
            or not isinstance(rule[key].get("nodes"), list)
            or not isinstance(rule[key].get("pageInfo"), dict)
            or rule[key]["pageInfo"].get("hasNextPage") is not False
        ):
            raise ValueError(
                "Existing branch allowances are incomplete; no changes made"
            )
    existing = checks(rule)
    changes = {key: value for key, value in REQUIRED.items() if rule[key] != value}
    if rule["bypassForcePushAllowances"]["nodes"]:
        changes["bypassForcePushActorIds"] = []
    if required_check not in existing:
        changes["requiredStatusChecks"] = [
            check for check in existing if check["context"] != CONTEXT
        ] + [required_check]
    if not changes:
        return {}
    if rule["pattern"] != BRANCH:
        raise ValueError(
            "A weak wildcard rule governs saturn/main; review an exact-branch policy without changing other branches"
        )
    return {"branchProtectionRuleId": rule["id"], **changes}


def read_state(repository):
    owner, name = repository.split("/")
    value = gh_api(
        "graphql", payload={"query": QUERY, "variables": {"owner": owner, "name": name}}
    )
    if value.get("errors"):
        raise ValueError(
            "GitHub returned policy errors; check Administration permissions"
        )
    try:
        current = value["data"]["repository"]
        if (
            not isinstance(current, dict)
            or current.get("nameWithOwner", "").lower() != repository.lower()
        ):
            raise ValueError("GitHub returned an unexpected repository")
        ref = current["ref"]
        if ref is None:
            raise ValueError(
                "The saturn/main branch is missing or inaccessible; no remote branch will be created"
            )
        if ref.get("name") != BRANCH or ref.get("prefix") != "refs/heads/":
            raise ValueError("GitHub returned an unexpected branch")
        if not isinstance(current["id"], str) or not current["id"]:
            raise ValueError("GitHub repository identity is missing")
        return current
    except (KeyError, TypeError, AttributeError):
        raise ValueError(
            "GitHub returned incomplete branch protection evidence"
        ) from None


def apply_and_verify(repository, state, desired, app_id):
    if state.get("viewerPermission") != "ADMIN":
        raise ValueError(
            "Setup requires repository Administration permission; no administrator bypass is used"
        )
    if read_state(repository) != state:
        raise ValueError(
            "Remote policy changed during preparation; inspect again before applying"
        )
    create = "repositoryId" in desired
    operation = "createBranchProtectionRule" if create else "updateBranchProtectionRule"
    input_type = (
        "CreateBranchProtectionRuleInput"
        if create
        else "UpdateBranchProtectionRuleInput"
    )
    query = f"mutation ForkProtection($input: {input_type}!) {{ {operation}(input: $input) {{ branchProtectionRule {{ id }} }} }}"
    result = gh_api(
        "graphql", payload={"query": query, "variables": {"input": desired}}
    )
    if result.get("errors") or not isinstance(
        result.get("data", {}).get(operation), dict
    ):
        raise ValueError(
            "GitHub did not confirm the protection update; inspect remote policy before retrying"
        )
    updated = read_state(repository)
    current_rule = updated["ref"]["branchProtectionRule"]
    if plan(current_rule, updated["id"], app_id):
        raise ValueError(
            "Remote protection still fails the required policy after setup"
        )
    previous_rule = state["ref"]["branchProtectionRule"]
    if previous_rule is not None:
        changed = set(desired) | {"requiredStatusCheckContexts", "requiredStatusChecks"}
        if "bypassForcePushActorIds" in desired:
            changed.add("bypassForcePushAllowances")
        if any(
            current_rule.get(key) != value
            for key, value in previous_rule.items()
            if key not in changed
        ):
            raise ValueError(
                "Unrelated remote policy changed during setup; stop and review remote protection"
            )
        expected = [
            check for check in checks(previous_rule) if check["context"] != CONTEXT
        ]
        if any(check not in checks(current_rule) for check in expected):
            raise ValueError(
                "An unrelated required check changed during setup; stop and review remote protection"
            )


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repo",
        required=True,
        help="Explicit public fork as OWNER/REPO; only saturn/main is targeted",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--check",
        action="store_true",
        help="Read-only check (the default); exit 1 for missing or weak protection",
    )
    mode.add_argument(
        "--apply",
        action="store_true",
        help="Explicitly strengthen remote branch protection, then verify",
    )
    args = parser.parse_args(argv)
    try:
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", args.repo) or any(
            part in {".", ".."} for part in args.repo.split("/")
        ):
            raise ValueError("Specify a GitHub OWNER/REPO without credentials or a URL")
        app = gh_api("apps/github-actions")
        app_id = app.get("node_id")
        if (
            app.get("slug") != "github-actions"
            or not isinstance(app_id, str)
            or not app_id
        ):
            raise ValueError(
                "GitHub Actions app binding is unavailable; no unbound required check will be installed"
            )
        state = read_state(args.repo)
        desired = plan(state["ref"]["branchProtectionRule"], state["id"], app_id)
        if desired and not args.apply:
            fields = sorted(
                set(desired) - {"repositoryId", "branchProtectionRuleId", "pattern"}
            )
            print(
                "FAIL saturn/main protection needs: " + ", ".join(fields),
                file=sys.stderr,
            )
            print(
                "Inspection made no changes. Review setup, then use --apply when authorized.",
                file=sys.stderr,
            )
            return 1
        if desired:
            apply_and_verify(args.repo, state, desired, app_id)
        print(
            "PASS saturn/main requires strict fork-verified from GitHub Actions, including admins; force pushes and deletion are blocked."
        )
        return 0
    except ValueError as error:
        print(f"FAIL GitHub policy: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
