SHELL := /usr/bin/env bash
.SHELLFLAGS := -euo pipefail -c

FORK_REMOTE ?= origin
UPSTREAM_REMOTE ?= upstream
FORK_REPO ?= saturnrobotics/carbon
UPSTREAM_REPO ?= crbnos/carbon
PROD_BRANCH ?= saturn/main
UPSTREAM_BRANCH ?= main
STAGING_WORKFLOW ?= saturn-staging.yml
PROD_WORKFLOW ?= saturn-production.yml

.PHONY: help guard-clean guard-gh feature push-feature feature-pr merge-pr \
	sync-upstream upstream-pr deploy-staging staging-status production-tag \
	production-status validate-domain-config test-domain-config

help: ## Show the Saturn branch and production commands.
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf "  %-20s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

guard-clean:
	@test -z "$$(git status --porcelain)" || { \
		echo "The worktree is dirty. Commit or stash your changes first." >&2; \
		exit 1; \
	}

guard-gh:
	@command -v gh >/dev/null || { echo "GitHub CLI (gh) is required." >&2; exit 1; }
	@gh auth status >/dev/null

validate-domain-config: ## Validate CONFIG_FILE for ENVIRONMENT=staging|production.
	@test -n "$(ENVIRONMENT)" || { \
		echo "Usage: make validate-domain-config ENVIRONMENT=staging CONFIG_FILE=/etc/carbon/staging.env" >&2; \
		exit 1; \
	}
	@test -n "$(CONFIG_FILE)" || { \
		echo "CONFIG_FILE is required." >&2; \
		exit 1; \
	}
	@contrib/deploying/simple-docker-caddy/scripts/validate-saturn-config.sh \
		"$(ENVIRONMENT)" "$(CONFIG_FILE)"

test-domain-config: ## Test Saturn domain validation with safe generated fixtures.
	@contrib/deploying/simple-docker-caddy/scripts/test-saturn-config-validator.sh
	@contrib/deploying/simple-docker-caddy/scripts/test-gcp-stack.sh

feature: guard-clean ## Create feat/NAME from the latest origin/saturn/main.
	@test -n "$(NAME)" || { echo "Usage: make feature NAME=my-change" >&2; exit 1; }
	@[[ "$(NAME)" =~ ^[a-z0-9][a-z0-9._-]*$$ ]] || { \
		echo "NAME must contain lowercase letters, numbers, dots, underscores, or hyphens." >&2; \
		exit 1; \
	}
	@git fetch "$(FORK_REMOTE)" "$(PROD_BRANCH)"
	@! git show-ref --verify --quiet "refs/heads/feat/$(NAME)" || { \
		echo "Local branch feat/$(NAME) already exists." >&2; exit 1; \
	}
	@! git ls-remote --exit-code --heads "$(FORK_REMOTE)" "feat/$(NAME)" >/dev/null 2>&1 || { \
		echo "Remote branch feat/$(NAME) already exists." >&2; exit 1; \
	}
	@git switch --create "feat/$(NAME)" "$(FORK_REMOTE)/$(PROD_BRANCH)"
	@echo "Created feat/$(NAME) from $(FORK_REMOTE)/$(PROD_BRANCH)."

push-feature: guard-clean ## Push the current feat/* branch to the Saturn fork.
	@branch="$$(git branch --show-current)"; \
	[[ "$$branch" == feat/* ]] || { echo "Current branch must be feat/*." >&2; exit 1; }; \
	git push --set-upstream "$(FORK_REMOTE)" "$$branch"

feature-pr: guard-clean guard-gh ## Open a PR from the current feat/* branch to saturn/main.
	@branch="$$(git branch --show-current)"; \
	[[ "$$branch" == feat/* ]] || { echo "Current branch must be feat/*." >&2; exit 1; }; \
	git push --set-upstream "$(FORK_REMOTE)" "$$branch"; \
	gh pr create --repo "$(FORK_REPO)" --base "$(PROD_BRANCH)" --head "$$branch" --fill

merge-pr: guard-gh ## Wait for required checks and merge PR=<number> into saturn/main.
	@test -n "$(PR)" || { echo "Usage: make merge-pr PR=123" >&2; exit 1; }
	@base="$$(gh pr view "$(PR)" --repo "$(FORK_REPO)" --json baseRefName --jq .baseRefName)"; \
	[ "$$base" = "$(PROD_BRANCH)" ] || { \
		echo "PR $(PR) targets $$base, not $(PROD_BRANCH)." >&2; exit 1; \
	}; \
	gh pr checks "$(PR)" --repo "$(FORK_REPO)" --required --watch; \
	gh pr merge "$(PR)" --repo "$(FORK_REPO)" --merge --delete-branch

sync-upstream: guard-clean guard-gh ## Fast-forward the fork's main branch from crbnos/carbon.
	@gh repo sync "$(FORK_REPO)" --source "$(UPSTREAM_REPO)" --branch "$(UPSTREAM_BRANCH)"
	@git fetch "$(FORK_REMOTE)" "$(UPSTREAM_BRANCH)"
	@echo "$(FORK_REPO):$(UPSTREAM_BRANCH) now mirrors $(UPSTREAM_REPO):$(UPSTREAM_BRANCH)."

upstream-pr: guard-gh ## Open a main -> saturn/main upstream integration PR.
	@gh pr create --repo "$(FORK_REPO)" \
		--base "$(PROD_BRANCH)" \
		--head "$(UPSTREAM_BRANCH)" \
		--title "chore: sync upstream Carbon" \
		--body "Integrate the latest reviewed $(UPSTREAM_REPO):$(UPSTREAM_BRANCH) changes into $(PROD_BRANCH)."

deploy-staging: guard-gh ## Redeploy the current origin/saturn/main SHA to staging.
	@git fetch "$(FORK_REMOTE)" "$(PROD_BRANCH)"; \
	sha="$$(git rev-parse "$(FORK_REMOTE)/$(PROD_BRANCH)^{commit}")"; \
	gh workflow run "$(STAGING_WORKFLOW)" --repo "$(FORK_REPO)" --ref "$(PROD_BRANCH)"; \
	echo "Requested staging deployment for $$sha. Production will require staging success."

staging-status: guard-gh ## Show the latest successful Saturn staging deployment.
	@gh run list --repo "$(FORK_REPO)" --workflow "$(STAGING_WORKFLOW)" \
		--branch "$(PROD_BRANCH)" --status success --limit 1 \
		--json databaseId,headSha,displayTitle,createdAt,url \
		--template '{{range .}}{{printf "commit: %s\nrun:    %s\ndate:   %s\nurl:    %s\n" .headSha .displayTitle .createdAt .url}}{{end}}'

production-status: guard-gh ## Show the latest successful Saturn production deployment.
	@gh run list --repo "$(FORK_REPO)" --workflow "$(PROD_WORKFLOW)" \
		--branch "$(PROD_BRANCH)" --status success --limit 1 \
		--json displayTitle,createdAt,url \
		--jq '.[0] | "commit: \(.displayTitle | sub("^Production "; ""))\nrun:    \(.displayTitle)\ndate:   \(.createdAt)\nurl:    \(.url)"'

production-tag: guard-clean guard-gh ## Tag the latest deployed commit; use TAG=prod-YYYY.MM.DD.N.
	@test -n "$(TAG)" || { echo "Usage: make production-tag TAG=prod-2026.07.16.1" >&2; exit 1; }
	@[[ "$(TAG)" =~ ^prod-[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[0-9]+$$ ]] || { \
		echo "TAG must match prod-YYYY.MM.DD.N." >&2; exit 1; \
	}
	@git fetch "$(FORK_REMOTE)" "$(PROD_BRANCH)" --tags
	@! git rev-parse -q --verify "refs/tags/$(TAG)" >/dev/null || { \
		echo "Tag $(TAG) already exists locally." >&2; exit 1; \
	}
	@! git ls-remote --exit-code --tags "$(FORK_REMOTE)" "refs/tags/$(TAG)" >/dev/null 2>&1 || { \
		echo "Tag $(TAG) already exists on $(FORK_REMOTE)." >&2; exit 1; \
	}
	@deployed_sha="$$(gh run list --repo "$(FORK_REPO)" --workflow "$(PROD_WORKFLOW)" \
		--branch "$(PROD_BRANCH)" --status success --limit 1 --json displayTitle \
		--jq '.[0].displayTitle | sub("^Production "; "")')"; \
	test -n "$$deployed_sha" || { echo "No successful production deployment found." >&2; exit 1; }; \
	branch_sha="$$(git rev-parse "$(FORK_REMOTE)/$(PROD_BRANCH)^{commit}")"; \
	[ "$$deployed_sha" = "$$branch_sha" ] || { \
		echo "Latest deployed commit $$deployed_sha is not current $(FORK_REMOTE)/$(PROD_BRANCH) $$branch_sha." >&2; \
		echo "Wait for the current production deployment to succeed before tagging." >&2; \
		exit 1; \
	}; \
	git tag --annotate "$(TAG)" "$$deployed_sha" \
		--message "Saturn production $(TAG) ($$deployed_sha)"; \
	git push "$(FORK_REMOTE)" "refs/tags/$(TAG)"; \
	echo "Created production tag $(TAG) at $$deployed_sha."
