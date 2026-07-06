.PHONY: install build test typecheck publish clean desktop dmg version bump help

NPM_PUBLISH_FLAGS ?= --access public

.DEFAULT_GOAL := help

help:
	@echo "Targets:"
	@echo "  install    Install dependencies"
	@echo "  build      Build the npm packages"
	@echo "  test       Run tests"
	@echo "  typecheck  Run TypeScript type checking"
	@echo "  publish    Build and publish to npm"
	@echo "  clean      Remove dist/"
	@echo "  desktop    Build the desktop app"
	@echo "  dmg        Build a macOS DMG (requires APPLE_ID and APPLE_PASSWORD)"
	@echo "  version    Print the current version"
	@echo "  bump       Bump the version (requires VERSION=major.minor.patch)"

install:
	bun install

version: install
	@bun run get-version

bump: install
ifndef VERSION
	$(error VERSION is not set; usage: make bump VERSION=0.2.0)
endif
	bun run bump-version $(VERSION)

build: install
	bun run build:npm

test: install
	bun test

typecheck: install
	bun run typecheck

publish: install build
	@set -eu; \
	for dir in dist/npm/argus-* dist/npm/argus; do \
		if [ -d "$$dir" ]; then \
			name=$$(node -p "require('./$$dir/package.json').name"); \
			version=$$(node -p "require('./$$dir/package.json').version"); \
			if npm view "$$name@$$version" version >/dev/null 2>&1; then \
				echo "Skipping $$name@$$version (already published)"; \
			else \
				(cd "$$dir" && npm publish $(NPM_PUBLISH_FLAGS)); \
			fi; \
		fi; \
	done

clean: install
	rm -rf dist/

desktop: install
	bun run desktop:build

dmg: install
ifndef APPLE_ID
	$(error APPLE_ID is not set)
endif
ifndef APPLE_PASSWORD
	$(error APPLE_PASSWORD is not set)
endif
	ARGUS_BUILD_ID=$(shell git rev-parse --short HEAD)-$(shell date +%Y%m%d) bun run desktop:dmg
