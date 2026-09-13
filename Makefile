.DEFAULT_GOAL := help

.PHONY: help deploy deploy-check deploy-plan deploy-maintenance deploy-portal deploy-portal-check

help:
	@printf '%s\n' \
	  'make deploy        Prepare and deploy; automatically handle required setup and migrations.' \
	  'make deploy-portal  Build and release the configured portal platform.' \
	  'make deploy-portal-check  Check portal setup without cloud changes.' \
	  'make deploy-check  Validate private deployment settings without cloud changes.' \
	  'make deploy-plan   Generate a private preview using read-only cloud queries.' \
	  'Setup guide: contrib/deploying/gcp-tailscale/README.md' \
	  'Portal setup: contrib/deploying/portal/README.md'

deploy-check:
	@bash ./contrib/deploying/gcp-tailscale/deploy.sh

deploy:
	@bash ./scripts/fork/drift.sh --pending || true
	@bash ./contrib/deploying/gcp-tailscale/deploy.sh --apply

deploy-plan:
	@bash ./contrib/deploying/gcp-tailscale/deploy.sh --plan

deploy-maintenance:
	@bash ./contrib/deploying/gcp-tailscale/deploy.sh --apply --maintenance

deploy-portal:
	@python3 ./contrib/deploying/portal/deploy.py --apply

deploy-portal-check:
	@python3 ./contrib/deploying/portal/deploy.py --check
