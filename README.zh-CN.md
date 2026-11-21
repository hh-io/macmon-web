# macmon-web

[English](README.md) | 简体中文

[macmon](https://github.com/vladkens/macmon) 的自定义 Web 监控页。Apple Silicon 的 CPU / GPU / 功耗 / 内存 / 温度 / 风扇 / 网络 / 磁盘实时面板。

- Go 单二进制，前端资源内嵌，不走 CDN，离线可用
- 不需要 `sudo`（macmon 本身就不需要）
- 只在有页面打开时采样，平时几乎零开销
- 界面支持中英文（默认跟随浏览器语言）和深浅色（默认跟随系统），可在顶栏右上角切换
- 适配手机屏幕：监听 `0.0.0.0:8000` 后，同一局域网的手机可直接访问，也能「添加到主屏幕」当作独立 App 使用

![macmon-web 监控面板，中文界面](docs/screenshots/dark-zh.webp)

<details>
<summary>英文界面</summary>

![macmon-web 监控面板，英文界面](docs/screenshots/dark-en.webp)

</details>

手机端（整页从上到下）：

![macmon-web 手机端，整页从上到下](docs/screenshots/mobile-zh.webp)

## 工作方式

```
浏览器 ──SSE /api/stream──▶ macmon-web（Go 单二进制，前端资源内嵌）──▶ macmon pipe（按需拉起）
```

- 有页面在看时才启动 `macmon pipe` 采样；最后一个页面断开 30s 后结束子进程。没人看时只剩一个空闲的 Go 进程。
- 页面切到后台（`visibilitychange`）会主动断开，回到前台再重连。
- 不依赖 `macmon serve`（它不发 CORS 头，浏览器无法跨源直连）。

## 依赖

- Apple Silicon 的 macOS
- `brew install macmon`
- Go 1.22+（构建）
- bun（只在修改样式、重新生成 CSS 时需要；`web/dist/app.css` 已提交，单纯 `go build` 不需要）

## 使用

```sh
make build      # 编译 ./macmon-web（只需 Go）
./macmon-web    # 打开 http://127.0.0.1:8000
```

参数：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `-addr` | `127.0.0.1:8000` | 监听地址；要局域网访问改成 `0.0.0.0:8000` |
| `-interval` | `1s` | 采样间隔 |
| `-idle` | `30s` | 无客户端多久后停止 macmon |
| `-macmon` | `macmon` | macmon 可执行文件路径 |
| `-probe` | 空（关闭） | 延迟探测目标，见[延迟探测](#延迟探测可选) |
| `-probe-interval` | `1m` | 探测间隔（最小 `15s`） |
| `-probe-keep` | `168h` | 延迟历史保留时长 |
| `-probe-data` | `~/Library/Application Support/macmon-web/latency.jsonl` | 延迟历史文件 |

> 没有任何认证。监听 `0.0.0.0` 时，同一网络里的任何人都能查看面板。

### 开机自启（可选）

```sh
make install-agent                        # 编译并注册为当前用户的 LaunchAgent，立即启动
make install-agent ADDR=0.0.0.0:8000      # 自定义监听地址
make install-agent PROBE='网关=192.168.1.1:80,tls:Google=google.com:443'   # 同时开启延迟探测
make uninstall-agent                      # 停止并移除
```

- plist 写在 `~/Library/LaunchAgents/local.macmon-web.plist`，日志在 `~/Library/Logs/macmon-web.log`。
- 安装时会记录 macmon 的绝对路径（launchd 的 PATH 不含 `/opt/homebrew/bin`）和本目录下二进制的路径；挪动仓库、重装 macmon 或重新编译后，再执行一次 `make install-agent` 即可。
- 进程异常退出会自动拉起；常驻开销很小：没人打开页面时不运行 macmon，Go 进程内存约 14MB。

### 延迟探测（可选）

默认关闭。加上 `-probe` 后会在后台（不管有没有打开页面）定时测量到若干目标的 TCP / TLS 延迟并保留几天历史，页面底部会多出一张「网络延迟」卡片，可切换 1h / 6h / 24h / 7d。

```sh
./macmon-web -probe '网关=192.168.1.1:80,tls:Google=google.com:443'
```

目标用逗号分隔，格式 `[tls:][名称=]host:port`：

- **直连**（默认）：socket 绑定物理网卡后计时 TCP 握手，**绕过 TUN 模式的代理 / VPN**，测的是宽带线路本身。域名通过该网卡的 DNS 解析，不走系统 DNS（fake-ip 代理会返回假地址）。仅支持 IPv4；不走代理就连不上的目标会显示 100% 丢包。
- **`tls:`**：照常走系统路由（含代理），计时到 TLS 握手完成，更接近浏览器的实际体验。只适用于 TLS 端口（443 等），数值包含代理节点耗时，不是纯 RTT。

为什么不用普通 TCP connect 或 ICMP：TUN 代理会在本地直接完成所有 TCP 握手，直接计时任何地址都只有 1ms 左右；ICMP 也常被代理伪造或丢弃。

每轮对每个目标连测 5 次，记录中位数 / 最大值 / 丢包。每个目标一张卡片，显示当前状态、所选时间范围内的平均 / P95 / 抖动 / 丢包，以及按丢包着色的分段状态条。图表为对数刻度，丢包以底部红色竖条标出，Mac 睡眠期间没有探测的断档用虚线连接（整轮超时处仍保持断开）。悬停卡片高亮对应曲线、点击隐藏 / 显示；悬停图表会弹出气泡，显示各目标在该时刻的数值。历史以 JSON Lines 追加写入 `-probe-data` 文件，每天整理一次，几个目标保留一周不到 10MB。

### 告警通知（可选）

本项目不内置通知，但借助 `/api/json` 很容易用脚本实现阈值告警。下面是推送到 [Bark](https://github.com/Finb/Bark) 或 Telegram 的示例，保存为 `~/bin/macmon-alert.sh`（`chmod +x`，需要 `brew install jq`）：

```sh
#!/bin/sh
set -eu
export PATH="/opt/homebrew/bin:$PATH"   # cron 的 PATH 不含 Homebrew

TEMP_MAX=90                             # CPU 温度，°C
SWAP_MAX=$((4 * 1024 * 1024 * 1024))    # swap 用量，字节

json=$(curl -sf -m 10 http://127.0.0.1:8000/api/json)
msg=$(printf '%s' "$json" | jq -r --argjson t "$TEMP_MAX" --argjson s "$SWAP_MAX" '
  [ (select(.temp.cpu_temp_avg > $t) | "CPU \(.temp.cpu_temp_avg | floor)°C"),
    (select(.memory.swap_usage > $s) | "Swap \(.memory.swap_usage / 1073741824 * 10 | floor / 10) GB") ]
  | join(", ")')
[ -z "$msg" ] && exit 0
title="macmon: $(scutil --get ComputerName)"

# Bark
curl -sf -m 10 https://api.day.app/push -H 'Content-Type: application/json; charset=utf-8' \
  -d "$(jq -n --arg k "$BARK_KEY" --arg t "$title" --arg b "$msg" '{device_key: $k, title: $t, body: $b}')" >/dev/null

# Telegram（替换 Bark 使用）
# curl -sf -m 10 "https://api.telegram.org/bot$TG_TOKEN/sendMessage" \
#   --data-urlencode "chat_id=$TG_CHAT_ID" --data-urlencode "text=$title — $msg" >/dev/null
```

用 `crontab -e` 每 5 分钟执行一次：

```
*/5 * * * * BARK_KEY=your_key $HOME/bin/macmon-alert.sh
```

- 每次检查会短暂拉起 macmon（`-idle` 后自动停止，默认 30s），不破坏“按需采样”；代价是每次检查约 30s 的采样。
- 这是单次采样判断：没有“持续 N 分钟”和冷却，超阈值期间每个周期都会推送一次。其他字段可以照此判断，字段见 `curl -s 127.0.0.1:8000/api/json | jq` 的输出。

接口：`GET /api/stream`（SSE，事件 `metrics` / `status`），`GET /api/json`（单次快照，调试用），`GET /api/latency?range=24h`（延迟历史，列式数据可直接喂给 uPlot；未开启 `-probe` 时返回 `{"enabled":false}`）。

## 兼容性

支持 Apple Silicon 全系（M1–M4 及 Pro / Max / Ultra），不支持 Intel 机型。CPU 核心卡片按 macmon 上报的核心簇动态布局，Ultra 的双 die 核心以 `D0·` / `D1·` 区分。

> Ultra 和三簇芯片只用模拟数据验证过，未经真机测试，遇到问题欢迎反馈。

## 开发

```sh
make css-watch   # 改 web/index.html / app.js / input.css 时实时生成 CSS；提交前跑一次 make css 生成压缩版
go run .         # 静态资源是 go:embed 嵌入的，改前端后需重启
```

前端：Tailwind CSS v4 + Alpine.js 3 + uPlot，第三方库放在 `web/vendor/`（离线可用，不走 CDN）。

## 致谢

所有指标数据来自 [@vladkens](https://github.com/vladkens) 的 [macmon](https://github.com/vladkens/macmon)（MIT）。本项目只以独立子进程方式调用 `macmon` 可执行文件，不包含其源代码；与 macmon 官方无关联。

## 许可证

MIT，见 [LICENSE](LICENSE)。
