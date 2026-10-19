# Local workflow. CI does the same steps in .github/workflows/.
# Laptop deploys need AWS credentials (e.g. `aws login` or AWS_PROFILE=...)
# plus infra/backend.hcl and infra/main/terraform.tfvars (both git-ignored).

TF       ?= terraform
REGION   ?= us-east-1
MAIN     := infra/main
BOOT     := infra/bootstrap

.PHONY: help install dev build scan test lint check \
        bootstrap-init bootstrap-plan bootstrap-apply bootstrap-migrate \
        init plan apply publish deploy

help: ## List targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-18s %s\n", $$1, $$2}'

install: ## Install site deps + headless Chromium for the PDF
	cd site && npm ci && npx playwright install chromium

dev: ## Run the site locally on http://localhost:4321
	cd site && npm run dev

build: ## Build site, render PDF, run PII scan
	cd site && npm run build

scan: ## Re-run the PII / secret scan on dist + repo
	cd site && npm run scan

test: ## Contact Lambda unit tests
	cd $(MAIN)/lambda/contact && python3 -m unittest -v

lint: ## terraform fmt + validate (no AWS access needed)
	$(TF) fmt -check -recursive infra
	$(TF) -chdir=$(BOOT) init -backend=false -input=false >/dev/null && $(TF) -chdir=$(BOOT) validate
	$(TF) -chdir=$(MAIN) init -backend=false -input=false >/dev/null && $(TF) -chdir=$(MAIN) validate

check: build test lint ## Everything CI checks before planning

# --- one-time bootstrap (docs/DEPLOYMENT.md, part 2) -------------------------

bootstrap-init: ## Init bootstrap with local state
	$(TF) -chdir=$(BOOT) init

bootstrap-plan: ## Plan bootstrap
	$(TF) -chdir=$(BOOT) plan -out=tfplan

bootstrap-apply: ## Apply bootstrap (state bucket, zone, OIDC roles)
	$(TF) -chdir=$(BOOT) apply tfplan && rm -f $(BOOT)/tfplan

bootstrap-migrate: ## Move bootstrap state into the S3 state bucket
	$(TF) -chdir=$(BOOT) init -migrate-state -backend-config=../backend.hcl

# --- main stack from the laptop (fallback; CI normally does this) -----------

init: ## Init main stack against the remote state
	$(TF) -chdir=$(MAIN) init -backend-config=../backend.hcl

plan: init ## Plan main stack
	$(TF) -chdir=$(MAIN) plan -out=tfplan

apply: ## Apply the saved main-stack plan
	$(TF) -chdir=$(MAIN) apply tfplan && rm -f $(MAIN)/tfplan

publish: ## Upload site/dist and invalidate CloudFront
	@bucket=$$($(TF) -chdir=$(MAIN) output -raw site_bucket); \
	dist=$$($(TF) -chdir=$(MAIN) output -raw distribution_id); \
	aws s3 sync site/dist/_astro "s3://$$bucket/_astro" --cache-control "public,max-age=31536000,immutable" --only-show-errors && \
	aws s3 sync site/dist "s3://$$bucket" --delete --exclude "_astro/*" --cache-control "public,max-age=300,must-revalidate" --only-show-errors && \
	aws cloudfront create-invalidation --distribution-id "$$dist" --paths '/*' --query Invalidation.Status --output text

deploy: check plan apply publish ## Laptop fallback: check, plan, apply, publish
