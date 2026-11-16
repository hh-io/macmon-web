BIN := macmon-web
TAILWIND := node_modules/.bin/tailwindcss

ADDR ?= 127.0.0.1:8000
LABEL := local.macmon-web
PLIST := $(HOME)/Library/LaunchAgents/$(LABEL).plist
LOG := $(HOME)/Library/Logs/macmon-web.log
DOMAIN := gui/$(shell id -u)

.PHONY: build css css-watch run clean install-agent uninstall-agent

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

# plist 里写的是本目录下二进制的绝对路径，挪动仓库后需重新执行
install-agent: build
	@MACMON=$$(command -v macmon) || { echo "找不到 macmon，请先 brew install macmon" >&2; exit 1; }; \
	mkdir -p $(dir $(PLIST)) $(dir $(LOG)); \
	sed -e 's|@LABEL@|$(LABEL)|' -e 's|@BIN@|$(CURDIR)/$(BIN)|' -e 's|@ADDR@|$(ADDR)|' \
	    -e "s|@MACMON@|$$MACMON|" -e 's|@LOG@|$(LOG)|g' launchd/macmon-web.plist.in > $(PLIST)
	@# 已加载时先卸载，保证新二进制和新配置生效
	@launchctl bootout $(DOMAIN)/$(LABEL) 2>/dev/null || true
	launchctl bootstrap $(DOMAIN) $(PLIST)
	@echo "已安装：http://$(ADDR)  日志：$(LOG)"

uninstall-agent:
	-launchctl bootout $(DOMAIN)/$(LABEL)
	rm -f $(PLIST)
