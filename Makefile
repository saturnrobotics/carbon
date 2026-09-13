.DEFAULT_GOAL := help

.PHONY: help deploy deploy-check deploy-plan deploy-maintenance deploy-knowledge deploy-knowledge-check

help:
	@printf '%s\n' \
	  'make deploy        Prepare and deploy; automatically handle required setup and migrations.' \
	  'make deploy-knowledge  Build and release the configured knowledge platform.' \
	  'make deploy-knowledge-check  Check knowledge setup without cloud changes.' \
	  'make deploy-check  Validate private deployment settings without cloud changes.' \
	  'make deploy-plan   Generate a private preview using read-only cloud queries.' \
	  'Setup guide: contrib/deploying/gcp-tailscale/README.md' \
	  'Knowledge setup: contrib/deploying/knowledge/README.md'

deploy-check:
	@bash ./contrib/deploying/gcp-tailscale/deploy.sh

deploy:
	@bash ./scripts/fork/drift.sh --pending || true
	@bash ./contrib/deploying/gcp-tailscale/deploy.sh --apply

deploy-plan:
	@bash ./contrib/deploying/gcp-tailscale/deploy.sh --plan

deploy-maintenance:
	@bash ./contrib/deploying/gcp-tailscale/deploy.sh --apply --maintenance

deploy-knowledge:
	@python3 ./contrib/deploying/knowledge/deploy.py --apply

deploy-knowledge-check:
	@python3 ./contrib/deploying/knowledge/deploy.py --check
