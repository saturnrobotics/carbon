.DEFAULT_GOAL := help

.PHONY: help sync deploy deploy-check deploy-plan deploy-maintenance

help:
	@printf '%s\n' \
	  'make sync          Merge upstream/main into an isolated candidate for agent review and verification.' \
	  'make deploy        Prepare and deploy; automatically handle required setup and migrations.' \
	  'make deploy-check  Validate private deployment settings without cloud changes.' \
	  'make deploy-plan   Generate a private preview using read-only cloud queries.' \
	  'Setup guide: contrib/deploying/gcp-tailscale/README.md'

sync:
	@bash ./contrib/deploying/gcp-tailscale/fork.sh sync

deploy-check:
	@bash ./contrib/deploying/gcp-tailscale/deploy.sh

deploy:
	@bash ./contrib/deploying/gcp-tailscale/deploy.sh --apply

deploy-plan:
	@bash ./contrib/deploying/gcp-tailscale/deploy.sh --plan

deploy-maintenance:
	@bash ./contrib/deploying/gcp-tailscale/deploy.sh --apply --maintenance
