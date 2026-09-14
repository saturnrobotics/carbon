.DEFAULT_GOAL := help

# Make consumes options itself; use FORCE=1 or append -- --force.
FORCE ?= 0
ifeq ($(FORCE),1)
DEPLOY_FORCE_FLAG := --force
else ifneq ($(FORCE),0)
$(error FORCE must be 0 or 1)
endif
ifneq ($(filter --force,$(MAKECMDGOALS)),)
DEPLOY_FORCE_FLAG := --force
endif
ifneq ($(DEPLOY_FORCE_FLAG),)
ifneq ($(filter-out deploy deploy-portal --force,$(MAKECMDGOALS)),)
$(error Force is supported only for deploy and deploy-portal)
endif
ifeq ($(filter deploy deploy-portal,$(MAKECMDGOALS)),)
$(error Force requires deploy or deploy-portal)
endif
endif

.PHONY: --force
--force:
	@:

.PHONY: help deploy deploy-check deploy-plan deploy-maintenance deploy-portal deploy-portal-check

help:
	@printf '%s\n' \
	  'make deploy        Prepare and deploy; automatically handle required setup and migrations.' \
	  'make deploy-portal  Build and release the configured portal platform.' \
	  'make deploy FORCE=1 / make deploy-portal FORCE=1  Skip GitHub CI-status checks for this invocation.' \
	  'make deploy-portal-check  Check portal setup without cloud changes.' \
	  'make deploy-check  Validate private deployment settings without cloud changes.' \
	  'make deploy-plan   Generate a private preview using read-only cloud queries.' \
	  'Setup guide: contrib/deploying/gcp-tailscale/README.md' \
	  'Portal setup: contrib/deploying/portal/README.md'

deploy-check:
	@bash ./contrib/deploying/gcp-tailscale/deploy.sh

deploy:
	@bash ./scripts/fork/drift.sh --pending || true
	@bash ./contrib/deploying/gcp-tailscale/deploy.sh --apply $(DEPLOY_FORCE_FLAG)

deploy-plan:
	@bash ./contrib/deploying/gcp-tailscale/deploy.sh --plan

deploy-maintenance:
	@bash ./contrib/deploying/gcp-tailscale/deploy.sh --apply --maintenance

deploy-portal:
	@python3 ./contrib/deploying/portal/deploy.py --apply $(DEPLOY_FORCE_FLAG)

deploy-portal-check:
	@python3 ./contrib/deploying/portal/deploy.py --check
