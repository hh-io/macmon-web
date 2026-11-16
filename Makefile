BIN := macmon-web
TAILWIND := node_modules/.bin/tailwindcss

ADDR ?= 127.0.0.1:8000
LABEL := local.macmon-web
PLIST := $(HOME)/Library/LaunchAgents/$(LABEL).plist
LOG := $(HOME)/Library/Logs/macmon-web.log
DOMAIN := gui/$(shell id -u)

.PHONY: build css css-watch run clean install-agent uninstall-agent

# 不依赖 css：web/dist/app.css 已提交，只装了 Go 也能构建；改样式后先 make css
build:
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

# plist 里写的是本目录下二进制和 macmon 的绝对路径（launchd 的 PATH 不含 /opt/homebrew/bin），挪动仓库后需重新执行
install-agent: build
	@set -e; \
	macmon=$$(command -v macmon) || { echo "找不到 macmon，请先 brew install macmon" >&2; exit 1; }; \
	mkdir -p "$(HOME)/Library/LaunchAgents" "$(HOME)/Library/Logs"; \
	cp launchd/macmon-web.plist.in "$(PLIST)"; \
	plutil -insert Label -string "$(LABEL)" "$(PLIST)"; \
	plutil -insert StandardOutPath -string "$(LOG)" "$(PLIST)"; \
	plutil -insert StandardErrorPath -string "$(LOG)" "$(PLIST)"; \
	plutil -insert ProgramArguments -array "$(PLIST)"; \
	for arg in "$(CURDIR)/$(BIN)" -addr "$(ADDR)" -macmon "$$macmon"; do \
	  plutil -insert ProgramArguments -string "$$arg" -append "$(PLIST)"; \
	done; \
	plutil -lint -s "$(PLIST)"
	@# bootout 是异步的，没等它卸载完就 bootstrap 会报 "Input/output error"
	@if launchctl print $(DOMAIN)/$(LABEL) >/dev/null 2>&1; then \
	  launchctl bootout $(DOMAIN)/$(LABEL); \
	  for i in $$(seq 50); do launchctl print $(DOMAIN)/$(LABEL) >/dev/null 2>&1 || break; sleep 0.1; done; \
	fi
	launchctl bootstrap $(DOMAIN) "$(PLIST)"
	@echo "已安装：http://$(ADDR)  日志：$(LOG)"

uninstall-agent:
	-launchctl bootout $(DOMAIN)/$(LABEL)
	rm -f "$(PLIST)"
