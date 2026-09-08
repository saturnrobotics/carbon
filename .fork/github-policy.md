# Enforce fork checks on GitHub

The local promotion and deployment helpers verify workflow evidence. GitHub branch
protection supplies the server-side check when a contributor or agent uses Git
directly. Inspect the public fork explicitly:

```bash
python3 .fork/github_policy.py --repo example/carbon --check
```

Replace `example/carbon` with the public fork's owner and repository. Omitting
`--check` has the same read-only behavior. Exit 0 means the inspected policy meets
the requirements; missing, weak, inaccessible, or malformed protection exits 1.
The helper never creates the `saturn/main` branch or changes any source commit.

After reviewing the proposed requirements and obtaining authorization to configure
the repository, apply them explicitly:

```bash
python3 .fork/github_policy.py --repo example/carbon --apply
```

Setup requires the GitHub CLI authenticated with repository Administration access.
It requires strict status checks, binds `fork-verified` to the GitHub Actions app,
enforces protection for administrators, and blocks deletion and force pushes,
including force-push allowances. It adds an exact `saturn/main` rule when absent.

Existing required checks retain their app bindings. Selective API updates leave
review counts, code-owner rules, signatures, push restrictions, deployment rules,
locks, and repository/organization rulesets unchanged. Setup rereads policy before
mutation, stops if it changed, and verifies the resulting policy afterward. A weak
wildcard rule stops for review because changing it could affect other branches.
The helper does not replace an inaccessible or malformed rule with defaults.

PR review is recommended for changes to these safeguards and the workflow itself.
Setup preserves existing PR requirements but does not introduce a new one: the
fork's verified fast-forward publication workflow remains supported. Administrators
and agents must not bypass protection, remove required checks, or weaken the
workflow to get a release through. Restrict who can administer these settings;
an actor able to change both enforcement and its checks can change the guarantees.

Classic branch protection and the exact `fork-verified` context are the baseline
this helper checks. Stronger rulesets remain active and may impose additional
requirements. A passing policy inspection is separate from a successful workflow
run for a particular revision.
