.DEFAULT_GOAL := help

.PHONY: help deploy deploy-check

help:
	@printf '%s\n' \
	  'make deploy-check  Validate private deployment settings without cloud changes.' \
	  'make deploy        Deploy the committed source to the configured GCP project.' \
	  'Setup guide: contrib/deploying/gcp-tailscale/README.md'

deploy-check:
	@bash ./contrib/deploying/gcp-tailscale/deploy.sh

deploy:
	@bash ./contrib/deploying/gcp-tailscale/deploy.sh --apply
