.PHONY: build test typecheck publish clean

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
