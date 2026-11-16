# macmon-web

[macmon](https://github.com/vladkens/macmon) 的自定义 Web 监控页。Apple Silicon 的 CPU / GPU / 功耗 / 内存 / 温度 / 风扇 / 网络 / 磁盘实时面板，跟随系统深浅色。

## 工作方式

```
浏览器 ──SSE /api/stream──▶ macmon-web（Go 单二进制，前端资源内嵌）──▶ macmon pipe（按需拉起）
```

- 有页面在看时才启动 `macmon pipe` 采样；最后一个页面断开 30s 后结束子进程。没人看时只剩一个空闲的 Go 进程。
- 页面切到后台（`visibilitychange`）会主动断开，回到前台再重连。
- 不依赖 `macmon serve`（它不发 CORS 头，浏览器无法跨源直连）。

## 依赖

- `brew install macmon`
- Go 1.22+（构建）
- bun（只在修改样式、重新生成 CSS 时需要；`web/dist/app.css` 已提交，单纯 `go build` 不需要）

## 使用

```sh
make build      # 生成 CSS + 编译 ./macmon-web
./macmon-web    # 打开 http://127.0.0.1:8000
```

参数：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `-addr` | `127.0.0.1:8000` | 监听地址；要局域网访问改成 `0.0.0.0:8000` |
| `-interval` | `1s` | 采样间隔 |
| `-idle` | `30s` | 无客户端多久后停止 macmon |
| `-macmon` | `macmon` | macmon 可执行文件路径 |

接口：`GET /api/stream`（SSE，事件 `metrics` / `status`），`GET /api/json`（单次快照，调试用）。

## 开发

```sh
make css-watch   # 改 web/index.html / app.js / input.css 时实时生成 CSS
go run .         # 静态资源是 go:embed 嵌入的，改前端后需重启
```

前端：Tailwind CSS v4 + Alpine.js 3 + uPlot，第三方库放在 `web/vendor/`（离线可用，不走 CDN）。
