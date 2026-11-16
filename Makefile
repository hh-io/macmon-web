BIN := macmon-web
TAILWIND := node_modules/.bin/tailwindcss

.PHONY: build css css-watch run clean

build: css
	go build -trimpath -ldflags="-s -w" -o $(BIN) .

node_modules: package.json
	bun install
	@touch node_modules

css: node_modules
	$(TAILWIND) -i web/input.css -o web/dist/app.css --minify

css-watch: node_modules
	$(TAILWIND) -i web/input.css -o web/dist/app.css --watch

run: build
	./$(BIN)

clean:
	rm -f $(BIN)
