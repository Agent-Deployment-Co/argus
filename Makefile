.PHONY: build test typecheck publish clean desktop dmg version bump help

.DEFAULT_GOAL := help

help:
	@echo "Targets:"
	@echo "  build      Build the project"
	@echo "  test       Run tests"
	@echo "  typecheck  Run TypeScript type checking"
	@echo "  publish    Build and publish to npm"
	@echo "  clean      Remove dist/"
	@echo "  desktop    Build the desktop app"
	@echo "  dmg        Build a macOS DMG (requires APPLE_ID and APPLE_PASSWORD)"
	@echo "  version    Print the current version"
	@echo "  bump       Bump the version (requires VERSION=major.minor.patch)"

version:
	@bun run get-version

bump:
ifndef VERSION
	$(error VERSION is not set; usage: make bump VERSION=0.2.0)
endif
	bun run bump-version $(VERSION)

build:
	bun run build

test:
	bun test

typecheck:
	bun run typecheck

publish: build
	npm publish --access public

clean:
	rm -rf dist/

desktop:
	bun run desktop:build

dmg:
ifndef APPLE_ID
	$(error APPLE_ID is not set)
endif
ifndef APPLE_PASSWORD
	$(error APPLE_PASSWORD is not set)
endif
	ARGUS_BUILD_ID=$(shell git rev-parse --short HEAD)-$(shell date +%Y%m%d) bun run desktop:dmg
