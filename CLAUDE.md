# CLAUDE.md

macmon 的自定义 Web 监控页：Go 单二进制（前端资源 `go:embed` 内嵌），按需拉起 `macmon pipe` 子进程采样，通过 SSE 推给浏览器。仅支持 Apple Silicon。用法见 README.md / README.zh-CN.md。

## 命令

```sh
make build        # go build -trimpath，产物 ./macmon-web（只需 Go，不依赖 bun）
go run .          # 开发运行；前端是 embed 的，改前端后要重启
make css-watch    # 改 index.html / app.js / input.css 时实时生成 CSS
make css          # 生成压缩版 web/dist/app.css——改过 Tailwind class 就必须跑并提交
gofmt -l . && go vet ./...   # 提交前检查（项目没有单独的 lint 配置，也没有测试）
curl -s 127.0.0.1:8000/api/json | jq   # 看一帧原始数据，确认字段名
```

## 结构

- `main.go`：flag 解析、HTTP 路由（`GET /` 静态、`/api/stream` SSE、`/api/json` 单帧快照）、优雅退出。
- `sampler.go`：`Sampler` 管理 macmon 子进程生命周期和订阅者广播。
- `web/app.js`：Alpine 组件 `dash`、I18N 字典、uPlot 图表、自定义指令 `x-num` / `x-spin`。
- `web/index.html`：页面模板；`<head>` 里有一段内联脚本在首帧前解析主题并设置 `data-theme`，避免闪烁。
- `web/input.css`：Tailwind v4 入口 + CSS 变量（深色为 `:root` 默认，浅色在 `:root[data-theme="light"]`）。
- `web/vendor/`：Alpine / uPlot 本地副本，离线可用，不要改成 CDN。
- `launchd/macmon-web.plist.in`：只含固定配置，Label / 路径 / 参数由 Makefile 用 `plutil` 写入。

## 约定与易踩的坑

- **新增 web 下的文件要同步改 `main.go` 的 `//go:embed` 列表**，否则不会被打包。
- **`web/dist/app.css` 是提交进仓库的**，保证只有 Go 也能构建。`input.css` 用 `source(none)` + 显式 `@source`，只扫描 `index.html` 和 `app.js`；在别处拼 class 名不会被生成。
- 前端请求保持相对路径（`api/stream`，不带前导 `/`）。
- I18N：新增文案要在 `I18N.zh` 和 `I18N.en` 里同时加。偏好存 localStorage（`macmon-lang` / `macmon-theme`），读写都包 try/catch，失败退回默认。
- 主题逻辑分两处：`index.html` 头部脚本（首帧）和 `app.js` 的 `resolveTheme`（运行时切换），改一处要对照另一处。
- `app.js` 的 `RECONNECT_MS` 与服务端 SSE `retry: 3000` 保持一致。
- Sampler 的并发不变量（改动前务必读懂注释）：
  - 状态全在 `mu` 下；`stop()` 和 `broadcast` 都在锁内，`broadcast` 先查 `ctx.Err()`，保证旧一轮采样不会写入数据。
  - 订阅通道只缓冲 1 帧，慢客户端丢旧帧，不阻塞其他人。
  - idle 定时器回调里要核对 `s.idleTimer == t`，因为已触发的旧定时器 `Stop()` 拦不住。
  - 新一轮启动时清空 `latest` / `lastErr`，不把过期数据推给新客户端。
  - Scanner 出错时要先 Kill 子进程再 Wait，否则 macmon 阻塞在写满的管道上。
- 找不到 macmon 时服务不退出，错误经 SSE `status` 事件推到页面。
- 代码注释用中文、只写 WHY；Go 日志用 `log/slog`，key 用英文小写。
- 改了用法 / 参数 / 接口时，`README.md`（英文）和 `README.zh-CN.md` 两份都要更新。
