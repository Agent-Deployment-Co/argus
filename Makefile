.PHONY: build test typecheck publish clean dmg help

.DEFAULT_GOAL := help

help:
	@echo "Targets:"
	@echo "  build      Build the project"
	@echo "  test       Run tests"
	@echo "  typecheck  Run TypeScript type checking"
	@echo "  publish    Build and publish to npm"
	@echo "  clean      Remove dist/"
	@echo "  dmg        Build a macOS DMG (requires APPLE_ID and APPLE_PASSWORD)"

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

dmg:
ifndef APPLE_ID
	$(error APPLE_ID is not set)
endif
ifndef APPLE_PASSWORD
	$(error APPLE_PASSWORD is not set)
endif
	ARGUS_BUILD_ID=$(shell git rev-parse --short HEAD)-$(shell date +%Y%m%d) bun run desktop:dmg
