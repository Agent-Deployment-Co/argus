.PHONY: build test typecheck publish clean dmg

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
	bun run desktop:dmg
