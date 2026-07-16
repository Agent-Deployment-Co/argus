.PHONY: install build test typecheck changelog publish clean desktop dmg version bump help

# GNU Make exposes OS=Windows_NT on Windows. On macOS, retain the cross-build
# path so one command produces the macOS app plus both Windows architectures.
ifeq ($(OS),Windows_NT)
DESKTOP_PLATFORM := windows
else ifeq ($(shell uname -s 2>/dev/null),Darwin)
DESKTOP_PLATFORM := macos
else
DESKTOP_PLATFORM := unsupported
endif

NPM_PUBLISH_FLAGS ?= --access public

.DEFAULT_GOAL := help

help:
	@echo "Targets:"
	@echo "  install    Install dependencies"
	@echo "  build      Build the npm packages"
	@echo "  test       Run tests"
	@echo "  typecheck  Run TypeScript type checking"
	@echo "  changelog  Rebuild docs/changelog.md from GitHub releases"
	@echo "  publish    Build and publish to npm"
	@echo "  clean      Remove dist/"
	@echo "  desktop    Build the native desktop app (macOS also cross-builds Windows x64/ARM64)"
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

changelog: install
	bun run docs:changelog

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
ifeq ($(DESKTOP_PLATFORM),windows)
	bun run desktop:build:windows:native
else ifeq ($(DESKTOP_PLATFORM),macos)
	@command -v cargo-xwin >/dev/null 2>&1 || { echo "cargo-xwin is required for the Windows desktop build (install it with cargo install --locked cargo-xwin)." >&2; exit 1; }
	@rustup target list --installed 2>/dev/null | grep -qx 'x86_64-pc-windows-msvc' || { echo "The x86_64-pc-windows-msvc Rust target is required (install it with rustup target add x86_64-pc-windows-msvc)." >&2; exit 1; }
	@rustup target list --installed 2>/dev/null | grep -qx 'aarch64-pc-windows-msvc' || { echo "The aarch64-pc-windows-msvc Rust target is required (install it with rustup target add aarch64-pc-windows-msvc)." >&2; exit 1; }
	bun run desktop:build
	bun run desktop:build:windows
	bun run desktop:build:windows:arm64
else
	@echo "The desktop build is supported on macOS and Windows." >&2; exit 1
endif

dmg: install
ifndef APPLE_ID
	$(error APPLE_ID is not set)
endif
ifndef APPLE_PASSWORD
	$(error APPLE_PASSWORD is not set)
endif
	ARGUS_BUILD_ID=$(shell git rev-parse --short HEAD)-$(shell date +%Y%m%d) bun run desktop:dmg
