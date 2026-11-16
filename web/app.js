"use strict";

// 按时间而不是点数裁剪：页面隐藏期间不采样，按点数留下的旧数据会把 x 轴拉长到断档之前，
// 新数据被挤到最右边。也让窗口和"最近 5 分钟"的文案在任意 --interval 下都对得上。
const HISTORY_SECONDS = 300;
// 超过这个间隔没数据（页面隐藏、断线）就在曲线上断开，而不是画一条假的连线。
const GAP_SECONDS = 3;
const GB = 1024 ** 3;
const NUM_EASE_MS = 650;
// 与服务端 SSE 的 retry: 3000 保持一致。
const RECONNECT_MS = 3000;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

const FMT = {
  int: (v) => Math.round(v).toString(),
  pct: (v) => Math.round(v * 100).toString(),
  w: (v) => (v >= 10 ? v.toFixed(1) : v.toFixed(2)),
  temp: (v) => v.toFixed(1),
  gb: (v) => (v / GB).toFixed(1),
  ghz: (v) => (v / 1000).toFixed(2),
  rate: (v) => {
    const units = ["B/s", "KB/s", "MB/s", "GB/s"];
    let i = 0;
    while (v >= 1000 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
  },
};

const I18N = {
  zh: {
    title: "macmon · 性能监控",
    "status.live": "实时",
    "status.connecting": "连接中",
    "status.reconnecting": "重连中",
    "status.paused": "已暂停",
    "status.error": "错误",
    sysPower: "整机功耗",
    usage5m: "利用率 · 最近 5 分钟",
    powerBreakdown: "功耗构成",
    chip: "芯片",
    adapter: "适配器",
    sysOverChip: "整机 / 芯片",
    min5: "5 分钟",
    cpuCores: "CPU 核心",
    nCores: (n) => `${n} 核`,
    "tier.E": "能效核心",
    "tier.P": "性能核心",
    "tier.S": "超级核心",
    "tier._": "CPU 核心",
    tierOther: (l) => `${l} 核心`,
    memory: "内存",
    used: "已用",
    memPressure: "内存压力",
    pressure: (p) => `压力 ${p}%`,
    pressureLevels: ["正常", "警告", "严重"],
    notInUse: "未使用",
    gpuMem: "GPU 内存 · 使用 / 分配",
    temperature: "温度",
    other: "其余",
    network: "网络",
    download: "下载",
    upload: "上传",
    disk: "磁盘",
    read: "读取",
    write: "写入",
    thermals: "散热",
    cpuTemp: "CPU 温度",
    gpuTemp: "GPU 温度",
    fan: (n) => `风扇 ${n}`,
    gpuCores: (n) => `${n} 核 GPU`,
    battery: (p, charging) => `电池 ${p}%${charging ? " · 充电中" : ""}`,
    uptime: (d, h, m) => (d > 0 ? `已运行 ${d} 天 ${h} 小时` : h > 0 ? `已运行 ${h} 小时 ${m} 分` : `已运行 ${m} 分`),
    footerSource: "数据来自",
    footerPause: "页面隐藏时暂停采样",
    errTitle: "无法获取 macmon 数据，正在重试…",
    parseErr: (msg) => `数据解析失败：${msg}`,
    switchLang: "Switch to English",
    "theme.system": "主题：跟随系统",
    "theme.light": "主题：浅色",
    "theme.dark": "主题：深色",
    latency: "网络延迟",
    "lat.avg": "平均",
    "lat.p95": "P95",
    "lat.jitter": "抖动",
    "lat.peak": "峰值",
    "lat.loss": "丢包",
    "lat.direct": "直连",
    "lat.tls": "TLS",
    "lat.directTip": "绕过代理，直接测 TCP 握手",
    "lat.tlsTip": "经系统路由（含代理），测 TLS 握手",
    "lat.s.ok": "正常",
    "lat.s.warn": "不稳",
    "lat.s.down": "中断",
    "lat.s.none": "无数据",
    "lat.timeout": "超时",
    "lat.empty": "这段时间没有数据",
    "lat.bucketLoss": (time, pct) => `${time} · 丢包 ${pct}`,
    "lat.bucketNone": (time) => `${time} · 无数据`,
    latHint: (sec, n) => `每 ${sec >= 60 ? `${Math.round(sec / 60)} 分钟` : `${sec} 秒`}探测 · ${n} 次取中位数`,
    latErr: (msg) => `延迟数据加载失败：${msg}`,
  },
  en: {
    title: "macmon · System Monitor",
    "status.live": "Live",
    "status.connecting": "Connecting",
    "status.reconnecting": "Reconnecting",
    "status.paused": "Paused",
    "status.error": "Error",
    sysPower: "System Power",
    usage5m: "Usage · Last 5 min",
    powerBreakdown: "Power Breakdown",
    chip: "chip",
    adapter: "Adapter",
    sysOverChip: "System / Chip",
    min5: "5 min",
    cpuCores: "CPU Cores",
    nCores: (n) => `${n} ${n === 1 ? "core" : "cores"}`,
    "tier.E": "Efficiency Cores",
    "tier.P": "Performance Cores",
    "tier.S": "Super Cores",
    "tier._": "CPU Cores",
    tierOther: (l) => `${l} Cores`,
    memory: "Memory",
    used: "Used",
    memPressure: "Memory Pressure",
    pressure: (p) => `Pressure ${p}%`,
    pressureLevels: ["Normal", "Warning", "Critical"],
    notInUse: "Not in use",
    gpuMem: "GPU Memory · In use / Allocated",
    temperature: "Temperature",
    other: "Other",
    network: "Network",
    download: "Download",
    upload: "Upload",
    disk: "Disk",
    read: "Read",
    write: "Write",
    thermals: "Thermals",
    cpuTemp: "CPU Temp",
    gpuTemp: "GPU Temp",
    fan: (n) => `Fan ${n}`,
    gpuCores: (n) => `${n}-core GPU`,
    battery: (p, charging) => `Battery ${p}%${charging ? " · Charging" : ""}`,
    uptime: (d, h, m) => (d > 0 ? `Up ${d}d ${h}h` : h > 0 ? `Up ${h}h ${m}m` : `Up ${m}m`),
    footerSource: "Data from",
    footerPause: "Sampling pauses while the page is hidden",
    errTitle: "Can't read macmon data, retrying…",
    parseErr: (msg) => `Failed to parse data: ${msg}`,
    switchLang: "切换到中文",
    "theme.system": "Theme: System",
    "theme.light": "Theme: Light",
    "theme.dark": "Theme: Dark",
    latency: "Latency",
    "lat.avg": "Avg",
    "lat.p95": "P95",
    "lat.jitter": "Jitter",
    "lat.peak": "Peak",
    "lat.loss": "Loss",
    "lat.direct": "Direct",
    "lat.tls": "TLS",
    "lat.directTip": "TCP handshake, bypassing proxies",
    "lat.tlsTip": "TLS handshake via system routing (incl. proxies)",
    "lat.s.ok": "OK",
    "lat.s.warn": "Unstable",
    "lat.s.down": "Down",
    "lat.s.none": "No data",
    "lat.timeout": "Timeout",
    "lat.empty": "No data in this range",
    "lat.bucketLoss": (time, pct) => `${time} · loss ${pct}`,
    "lat.bucketNone": (time) => `${time} · no data`,
    latHint: (sec, n) => `Every ${sec >= 60 ? `${Math.round(sec / 60)} min` : `${sec} s`} · median of ${n}`,
    latErr: (msg) => `Failed to load latency data: ${msg}`,
  },
};

const THEMES = ["system", "light", "dark"];
const darkScheme = window.matchMedia("(prefers-color-scheme: dark)");

// 隐私模式或禁用站点数据时 localStorage 会抛异常；偏好只是锦上添花，读写失败就退回默认值。
function loadPref(key) {
  try {
    return localStorage.getItem(`macmon-${key}`);
  } catch {
    return null;
  }
}

function savePref(key, value) {
  try {
    localStorage.setItem(`macmon-${key}`, value);
  } catch {
    // 存不下只影响下次打开时的默认值，不影响当前页面。
  }
}

function initialLang() {
  const saved = loadPref("lang");
  if (saved in I18N) return saved;
  return navigator.language?.toLowerCase().startsWith("zh") ? "zh" : "en";
}

// 与 index.html 头部脚本的解析规则保持一致。
function resolveTheme(theme) {
  if (theme === "light" || theme === "dark") return theme;
  return darkScheme.matches ? "dark" : "light";
}

// 历史数据和图表实例放在 Alpine 响应式系统之外：每秒变更几百个点，代理化纯属浪费。
const hist = {
  t: [],
  cpu: [],
  gpu: [],
  chip: [],
  sys: [],
  netIn: [],
  netOut: [],
  diskR: [],
  diskW: [],
};
const charts = [];

// 每个核心最近 60 个点的利用率，用来画核心卡片里的迷你曲线。
const CORE_POINTS = 60;
const coreHist = new Map();
let coreLastT = null;

// 曲线固定 60 个槽位、右对齐：新数据从右侧进入，未满时左边留空，而不是把少量点拉伸铺满。
function corePath(values) {
  const step = 60 / (CORE_POINTS - 1);
  const x0 = (CORE_POINTS - values.length) * step;
  const pts = values.map((v, i) => `${(x0 + i * step).toFixed(2)},${(31 - Math.min(1, Math.max(0, v)) * 29).toFixed(2)}`);
  const line = `M${pts.join("L")}`;
  return { line, area: `${line}L60,32L${x0.toFixed(2)},32Z` };
}

// Ultra 芯片有两个 die，macmon 的 core_id 在每个 die 内都从 0 开始，所以 key 必须带上 die_id。
const coreKey = (tier, core) => `${tier.label}-${core.die_id ?? 0}-${core.core_id}`;

// 每行最少能放下的单核卡片宽度（5.5rem 加上 gap）。
const CORE_CELL_MIN_PX = 96;

function updateCorePaths(m) {
  // 迷你图没有断点表示法，断档（页面隐藏、断线）后直接重新开始，避免把相隔很久的两段画成相邻点。
  const t = Date.parse(m.timestamp) / 1000;
  if (coreLastT != null && t - coreLastT > GAP_SECONDS) coreHist.clear();
  coreLastT = t;
  const paths = {};
  for (const tier of m.cpu_tiers ?? []) {
    for (const core of tier.cores) {
      const key = coreKey(tier, core);
      let arr = coreHist.get(key);
      if (!arr) coreHist.set(key, (arr = []));
      arr.push(core.active_ratio);
      if (arr.length > CORE_POINTS) arr.shift();
      paths[key] = corePath(arr);
    }
  }
  return paths;
}

function pushHistory(m) {
  const t = Date.parse(m.timestamp) / 1000;
  const last = hist.t[hist.t.length - 1];
  if (last != null && t - last > GAP_SECONDS) {
    for (const k in hist) hist[k].push(k === "t" ? last + 0.001 : null);
  }
  hist.t.push(t);
  hist.cpu.push(m.cpu_active_ratio * 100);
  hist.gpu.push(m.gpu_active_ratio * 100);
  hist.chip.push(m.chip_power);
  hist.sys.push(m.sys_power);
  hist.netIn.push(m.net_in);
  hist.netOut.push(m.net_out);
  hist.diskR.push(m.disk_read);
  hist.diskW.push(m.disk_write);
  // 裁掉窗口外的点；开头若剩下断档标记（null）也一并去掉，免得左端留一截空白。
  while (hist.t.length > 1 && (hist.t[0] < t - HISTORY_SECONDS || hist.cpu[0] == null)) {
    for (const k in hist) hist[k].shift();
  }
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
}

function withAlpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function gradientFill(color, top) {
  return (u) => {
    const g = u.ctx.createLinearGradient(0, u.bbox.top, 0, u.bbox.top + u.bbox.height);
    g.addColorStop(0, withAlpha(color, top));
    g.addColorStop(1, withAlpha(color, 0));
    return g;
  };
}

// uPlot 默认时间刻度是 ":30" 加一行美式日期，这里统一成 24 小时制；刻度都在整分时省掉秒。
function timeTicks(_, splits) {
  const pad = (n) => String(n).padStart(2, "0");
  const withSec = splits.some((ts) => ts % 60 !== 0);
  return splits.map((ts) => {
    const d = new Date(ts * 1000);
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return withSec ? `${hm}:${pad(d.getSeconds())}` : hm;
  });
}

function makeChart(el, { series, data, axes = false, range }) {
  const muted = cssVar("muted");
  const font = "11px ui-sans-serif, -apple-system, sans-serif";
  const opts = {
    width: el.clientWidth || 300,
    height: el.clientHeight || 64,
    padding: axes ? [8, 8, 0, 0] : [4, 0, 2, 0],
    legend: { show: false },
    cursor: axes ? { drag: { x: false, y: false }, points: { size: 7 } } : { show: false },
    scales: { x: { time: true }, y: { range } },
    axes: axes
      ? [
          { stroke: muted, font, grid: { show: false }, ticks: { show: false }, space: 90, size: 30, values: timeTicks },
          {
            stroke: muted,
            font,
            size: 44,
            grid: { stroke: cssVar("line"), width: 1 },
            ticks: { show: false },
            values: (_, vals) => vals.map((v) => `${v}%`),
          },
        ]
      : [{ show: false }, { show: false }],
    series: [
      {},
      ...series.map((s) => {
        const color = cssVar(s.color);
        return {
          stroke: color,
          width: s.width ?? 2,
          fill: s.fill ? gradientFill(color, s.fill) : undefined,
          points: { show: false },
          paths: uPlot.paths.spline(),
        };
      }),
    ],
  };
  const u = new uPlot(opts, data(), el);
  let pending = 0;
  const ro = new ResizeObserver(() => {
    // 放到下一帧再改尺寸：在 RO 回调里同步改布局会触发 "ResizeObserver loop" 警告。
    // 尺寸取容器本身（容器高度由 CSS 决定且 overflow:hidden），画布不会反过来撑大容器。
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => {
      if (el.clientWidth > 0 && el.clientHeight > 0) u.setSize({ width: el.clientWidth, height: el.clientHeight });
    });
  });
  ro.observe(el);
  charts.push({ u, ro, data });
}

// 稀疏线 y 轴从 0 开始，并留出一点顶部空间；全 0 时给个最小值，避免一条贴底的线乱跳。
const sparkRange = (floor) => (_, _min, max) => [0, Math.max((max ?? 0) * 1.2, floor)];

function buildCharts(root) {
  for (const c of charts) {
    c.ro.disconnect();
    c.u.destroy();
  }
  charts.length = 0;

  makeChart(root.querySelector("[x-ref=usageChart]"), {
    axes: true,
    range: [0, 100],
    series: [
      { color: "cpu", fill: 0.28 },
      { color: "gpu", fill: 0.22 },
    ],
    data: () => [hist.t, hist.cpu, hist.gpu],
  });
  makeChart(root.querySelector("[x-ref=powerChart]"), {
    range: sparkRange(1),
    series: [
      { color: "sys", fill: 0.18, width: 1.5 },
      { color: "power", fill: 0.3, width: 1.5 },
    ],
    data: () => [hist.t, hist.sys, hist.chip],
  });
  makeChart(root.querySelector("[data-spark=net]"), {
    range: sparkRange(1024),
    series: [
      { color: "cpu", fill: 0.25, width: 1.5 },
      { color: "ane", fill: 0.2, width: 1.5 },
    ],
    data: () => [hist.t, hist.netIn, hist.netOut],
  });
  makeChart(root.querySelector("[data-spark=disk]"), {
    range: sparkRange(1024),
    series: [
      { color: "mem", fill: 0.25, width: 1.5 },
      { color: "power", fill: 0.2, width: 1.5 },
    ],
    data: () => [hist.t, hist.diskR, hist.diskW],
  });
}

function refreshCharts() {
  for (const c of charts) c.u.setData(c.data());
}

// 延迟历史：按钮文案 -> 服务端 range 参数（Go duration 不支持 d）和窗口秒数。
const LAT_RANGES = {
  "1h": { q: "1h", sec: 3600 },
  "6h": { q: "6h", sec: 6 * 3600 },
  "24h": { q: "24h", sec: 86400 },
  "7d": { q: "168h", sec: 7 * 86400 },
};
// 不用 mem / power / temp：它们是状态条和状态标签的绿黄红，曲线再用会被误读成状态。
const LAT_COLORS = ["cpu", "gpu", "ane", "ecpu", "mcpu", "sys"];
const LAT_BUCKETS = 40;
// 卡片最小宽度 15rem 加上 gap，用来算一行放几张。
const LAT_TILE_MIN_PX = 240 + 12;
const LAT_STATE_COLOR = { ok: "mem", warn: "power", down: "temp" };
// 与 macmon 帧一样放在 Alpine 之外：7 天 × 每分钟一个点，代理化会很慢。
// summary 在拉取时算好：悬停时 latRows 每次 mousemove 都会重算，不能每次都遍历上万个点。
const lat = { interval: 60, count: 5, from: 0, to: 0, t: [], series: [], summary: [] };
let latChart = null;

const pad2 = (n) => String(n).padStart(2, "0");
const fmtPct = (r) => (r == null ? "—" : `${(r * 100).toFixed(r > 0 && r < 0.01 ? 2 : r >= 0.1 ? 0 : 1)}%`);
const fmtMdHm = (ts) => {
  const d = new Date(ts * 1000);
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

// 丢包比例 -> 状态。单轮：全丢算中断、丢了一部分算不稳。
// 聚合的一段时间里偶尔丢一次很正常（180 次丢 1 次也才 0.6%），所以低于 2% 仍算正常，否则状态条一片黄。
function lossState(lost, total) {
  if (total <= 0) return null;
  const r = lost / total;
  if (r === 0 || (total > lat.count && r < 0.02)) return "ok";
  return r >= (total > lat.count ? 0.2 : 1) ? "down" : "warn";
}

function summarize(s) {
  const vals = [];
  let jitterSum = 0;
  let jitterN = 0;
  let prev = null;
  let lost = 0;
  let probes = 0;
  const buckets = Array.from({ length: LAT_BUCKETS }, () => ({ lost: 0, total: 0 }));
  const span = lat.to - lat.from;
  for (let i = 0; i < lat.t.length; i++) {
    const v = s.p50[i];
    if (v != null) {
      vals.push(v);
      if (prev != null) {
        jitterSum += Math.abs(v - prev);
        jitterN++;
      }
    }
    // 断档（null）后重新开始算抖动，不把睡眠前后的两个点当成相邻。
    prev = v;
    if (s.lost[i] == null) continue;
    lost += s.lost[i];
    probes += lat.count;
    const b = Math.floor(((lat.t[i] - lat.from) / span) * LAT_BUCKETS);
    if (b >= 0 && b < LAT_BUCKETS) {
      buckets[b].lost += s.lost[i];
      buckets[b].total += lat.count;
    }
  }
  const sorted = [...vals].sort((a, b) => a - b);
  let lastIdx = -1;
  for (let j = s.lost.length - 1; j >= 0; j--) {
    if (s.lost[j] != null) {
      lastIdx = j;
      break;
    }
  }
  return {
    avg: vals.length ? vals.reduce((a, v) => a + v, 0) / vals.length : null,
    p95: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : null,
    jitter: jitterN ? jitterSum / jitterN : null,
    loss: probes ? lost / probes : null,
    last: lastIdx >= 0 ? s.p50[lastIdx] : null,
    lastState: lastIdx >= 0 ? lossState(s.lost[lastIdx], lat.count) : null,
    buckets: buckets.map((b, i) => ({ state: lossState(b.lost, b.total), loss: b.total ? b.lost / b.total : null, t: lat.from + ((i + 0.5) * span) / LAT_BUCKETS })),
  };
}

// 合盖睡眠、服务停机期间没有探测，超过 2.5 个间隔就插一个空点让曲线断开，不画假的连线。
function setLatency(resp, rangeSec) {
  const gap = resp.interval * 2.5;
  const t = [];
  const series = resp.series.map((s) => ({ id: s.id, name: s.name, mode: s.mode, p50: [], max: [], lost: [] }));
  resp.t.forEach((ts, i) => {
    if (t.length && ts - t[t.length - 1] > gap) {
      t.push(t[t.length - 1] + 1);
      for (const s of series) {
        s.p50.push(null);
        s.max.push(null);
        s.lost.push(null);
      }
    }
    t.push(ts);
    resp.series.forEach((src, si) => {
      series[si].p50.push(src.p50[i]);
      series[si].max.push(src.max[i]);
      series[si].lost.push(src.lost[i]);
    });
  });
  const ids = (a) => a.map((s) => s.id).join();
  const changed = ids(series) !== ids(lat.series);
  // x 轴固定为所选窗口而不是数据范围：数据刚开始积累时一眼能看出只有最近一小段。
  const to = Date.now() / 1000;
  Object.assign(lat, { interval: resp.interval, count: resp.count, from: to - rangeSec, to, t, series });
  lat.summary = series.map(summarize);
  return changed;
}

const latData = () => [lat.t, ...lat.series.map((s) => s.p50)];

function latTicks(u, splits) {
  const long = u.scales.x.max - u.scales.x.min > 36 * 3600;
  return splits.map((ts) => {
    const d = new Date(ts * 1000);
    const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    if (!long) return hm;
    return hm === "00:00" ? `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}` : `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${hm}`;
  });
}

// 刻度最小 1 分钟：探测本来就是分钟级，秒级刻度格式化后会出现重复的 "05:28"。
const LAT_X_INCRS = [60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800];

// 对数轴按 1-2-5 取整，比 uPlot 默认的整数量级更贴合数据，也不会出现一堆不标数字的次网格线。
function floor125(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  const m = v / p;
  return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p;
}
function ceil125(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  const m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}
function latYRange(_, min, max) {
  const lo = floor125(Math.max((min ?? 1) / 1.4, 0.5));
  const hi = ceil125(Math.max((max ?? 10) * 1.3, lo * 2));
  return [lo, hi];
}
function latYSplits(u) {
  const { min, max } = u.scales.y;
  const decades = Math.log10(max / min);
  const mant = decades > 2.5 ? [1] : decades > 1.2 ? [1, 3] : [1, 2, 5];
  const out = [];
  for (let p = 10 ** Math.floor(Math.log10(min)); p <= max; p *= 10) {
    for (const m of mant) {
      const v = +(m * p).toPrecision(3);
      if (v >= min * 0.999 && v <= max * 1.001) out.push(v);
    }
  }
  return out;
}
const fmtMs = (v) => (v >= 1000 ? `${+(v / 1000).toFixed(1)} s` : `${+v.toPrecision(3)} ms`);

// 丢包画成底部的细竖条：宽度按一个探测间隔，限制在几像素内并裁到绘图区，点少时也不会糊成一大块。
function drawLoss(u) {
  const { ctx, bbox } = u;
  const dpr = devicePixelRatio;
  const step = u.valToPos(lat.from + lat.interval, "x", true) - u.valToPos(lat.from, "x", true);
  const w = Math.min(Math.max(step * 0.8, 2 * dpr), 4 * dpr);
  ctx.save();
  ctx.beginPath();
  ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height);
  ctx.clip();
  ctx.fillStyle = withAlpha(cssVar("temp"), 0.7);
  for (let i = 0; i < lat.t.length; i++) {
    let ratio = 0;
    lat.series.forEach((s, si) => {
      if (u.series[si + 1].show && s.lost[i] > 0) ratio = Math.max(ratio, s.lost[i] / lat.count);
    });
    if (ratio === 0) continue;
    const x = u.valToPos(lat.t[i], "x", true);
    const h = (3 + ratio * 9) * dpr;
    ctx.fillRect(x - w / 2, bbox.top + bbox.height - h, w, h);
  }
  ctx.restore();
}

function buildLatChart(el, onHover, hidden) {
  if (latChart) {
    latChart.ro.disconnect();
    latChart.u.destroy();
    latChart = null;
  }
  if (!el || !lat.series.length) return;
  const muted = cssVar("muted");
  const font = "11px ui-sans-serif, -apple-system, sans-serif";
  const u = new uPlot(
    {
      width: el.clientWidth || 300,
      height: el.clientHeight || 224,
      padding: [10, 8, 0, 0],
      legend: { show: false },
      cursor: { drag: { x: false, y: false }, points: { size: 7 } },
      focus: { alpha: 0.18 },
      // 对数刻度：直连几毫秒和经代理几百毫秒的目标常在同一张图里，线性轴会把小值压成一条贴底的线。
      scales: {
        x: { time: true, range: () => [lat.from, lat.to] },
        y: { distr: 3, range: latYRange },
      },
      axes: [
        { stroke: muted, font, grid: { show: false }, ticks: { show: false }, space: 90, size: 28, incrs: LAT_X_INCRS, values: latTicks },
        {
          stroke: muted,
          font,
          size: 58,
          gap: 8,
          grid: { stroke: cssVar("line"), width: 1 },
          ticks: { show: false },
          splits: latYSplits,
          values: (_, vals) => vals.map(fmtMs),
        },
      ],
      series: [
        {},
        ...lat.series.map((s, i) => ({
          show: !hidden[s.id],
          stroke: cssVar(LAT_COLORS[i % LAT_COLORS.length]),
          width: 1.75,
          // 不写死 show：数据稀疏时 uPlot 自动画点，刚开始积累的几个点不会只剩几段看不清的短线。
          points: { size: 5, width: 1.5 },
        })),
      ],
      hooks: {
        draw: [drawLoss],
        setCursor: [(u) => onHover(u)],
      },
    },
    latData(),
    el,
  );
  let pending = 0;
  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => {
      if (el.clientWidth > 0 && el.clientHeight > 0) u.setSize({ width: el.clientWidth, height: el.clientHeight });
    });
  });
  ro.observe(el);
  latChart = { u, ro };
}

document.addEventListener("alpine:init", () => {
  // x-num.<fmt>="expr"：数字变化时缓动过渡，而不是直接跳变。
  Alpine.directive("num", (el, { modifiers, expression }, { evaluateLater, effect, cleanup }) => {
    const get = evaluateLater(expression);
    const fmt = FMT[modifiers[0]] ?? FMT.int;
    let cur = null;
    let raf = 0;
    effect(() =>
      get((v) => {
        cancelAnimationFrame(raf);
        if (v == null || Number.isNaN(v)) {
          cur = null;
          el.textContent = "—";
          return;
        }
        if (cur == null || reducedMotion.matches || document.hidden) {
          cur = v;
          el.textContent = fmt(v);
          return;
        }
        const from = cur;
        const t0 = performance.now();
        const step = (now) => {
          const k = Math.min(1, (now - t0) / NUM_EASE_MS);
          cur = from + (v - from) * (1 - (1 - k) ** 3);
          el.textContent = fmt(cur);
          if (k < 1) raf = requestAnimationFrame(step);
        };
        raf = requestAnimationFrame(step);
      }),
    );
    cleanup(() => cancelAnimationFrame(raf));
  });

  // x-spin="0..1"：按转速比例持续旋转。用累积角度而不是 CSS 动画，改变速度时不会跳帧。
  Alpine.directive("spin", (el, { expression }, { evaluateLater, effect, cleanup }) => {
    const get = evaluateLater(expression);
    let speed = 0;
    let angle = 0;
    let last = performance.now();
    let raf = 0;
    effect(() =>
      get((v) => {
        speed = v > 0 ? 90 + v * 900 : 0;
      }),
    );
    const tick = (now) => {
      angle = (angle + (speed * (now - last)) / 1000) % 360;
      last = now;
      if (!reducedMotion.matches) el.style.transform = `rotate(${angle}deg)`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    cleanup(() => cancelAnimationFrame(raf));
  });

  Alpine.data("dash", () => {
    let es = null;
    let latTimer = 0;
    // 切换范围、回到前台和定时刷新可能并发请求：只认最新一次，旧响应既不覆盖数据也不再排定时器，免得轮询链越叠越多。
    let latSeq = 0;

    return {
      m: null,
      soc: null,
      corePaths: {},
      coreGridW: 0,
      multiDie: false,
      status: "connecting",
      error: "",
      lang: initialLang(),
      theme: THEMES.includes(loadPref("theme")) ? loadPref("theme") : "system",
      latEnabled: false,
      latRange: Object.hasOwn(LAT_RANGES, loadPref("lat-range") ?? "") ? loadPref("lat-range") : "24h",
      latHover: null,
      latVer: 0,
      latError: "",
      latHidden: {},
      // 状态条的颜色和提示文案只随数据和语言变化，单独存放：放进 latRows 会在每次 mousemove 时重建上百个 Date 和字符串。
      latBucketRows: [],
      latGridW: 0,
      // 气泡位置（相对图表容器，CSS 像素）；null 表示不显示。
      latTip: null,

      t(key, ...args) {
        const v = I18N[this.lang][key] ?? I18N.zh[key];
        return typeof v === "function" ? v(...args) : v;
      },

      applyLang() {
        document.documentElement.lang = this.lang === "zh" ? "zh-CN" : "en";
        document.title = this.t("title");
      },

      toggleLang() {
        this.lang = this.lang === "zh" ? "en" : "zh";
        savePref("lang", this.lang);
        this.applyLang();
        this.buildLatBuckets();
      },

      applyTheme() {
        const resolved = resolveTheme(this.theme);
        if (document.documentElement.dataset.theme === resolved) return;
        document.documentElement.dataset.theme = resolved;
        // 图表颜色在创建时从 CSS 变量取值，主题变了只能重建。
        buildCharts(this.$root);
        this.rebuildLatChart();
      },

      cycleTheme() {
        this.theme = THEMES[(THEMES.indexOf(this.theme) + 1) % THEMES.length];
        savePref("theme", this.theme);
        this.applyTheme();
      },

      init() {
        this.applyLang();
        document.documentElement.dataset.theme = resolveTheme(this.theme);
        this.$nextTick(() => buildCharts(this.$root));
        new ResizeObserver(([entry]) => {
          this.coreGridW = entry.contentRect.width;
        }).observe(this.$refs.coreCard);
        new ResizeObserver(([entry]) => {
          this.latGridW = entry.contentRect.width;
        }).observe(this.$refs.latGrid);
        // 在后台标签页打开（或恢复会话）时不会触发 visibilitychange，需要在这里就判断。
        if (document.hidden) this.status = "paused";
        else this.connect();
        document.addEventListener("visibilitychange", () => {
          if (document.hidden) {
            this.disconnect();
            // 已排好的刷新不能在后台照常触发。
            clearTimeout(latTimer);
            return;
          }
          this.connect();
          // 探测在服务端后台持续进行，页面只是不在隐藏时拉取；回到前台立刻补一次。没开启探测就不用问了。
          if (this.latEnabled || this.latError) this.fetchLatency();
        });
        this.fetchLatency();
        darkScheme.addEventListener("change", () => {
          if (this.theme === "system") this.applyTheme();
        });
      },

      connect() {
        if (es) return;
        this.status = "connecting";
        es = new EventSource("api/stream");
        es.addEventListener("metrics", (e) => {
          let data;
          try {
            data = JSON.parse(e.data);
          } catch (err) {
            this.status = "error";
            this.error = this.t("parseErr", err.message);
            return;
          }
          this.onMetrics(data);
        });
        es.addEventListener("status", (e) => {
          this.status = "error";
          try {
            this.error = JSON.parse(e.data).message;
          } catch {
            this.error = e.data;
          }
        });
        es.onerror = () => {
          // EventSource 会自动重连；只在没有更具体错误时显示"重连中"。
          if (this.status !== "error") this.status = "reconnecting";
          // 服务返回非 200 或错误的 Content-Type 时浏览器会永久放弃，只能自己重建连接。
          if (es?.readyState === EventSource.CLOSED) {
            es = null;
            setTimeout(() => {
              if (!document.hidden) this.connect();
            }, RECONNECT_MS);
          }
        };
      },

      disconnect() {
        if (!es) return;
        es.close();
        es = null;
        this.status = "paused";
      },

      async fetchLatency() {
        clearTimeout(latTimer);
        const seq = ++latSeq;
        try {
          const range = LAT_RANGES[this.latRange];
          const res = await fetch(`api/latency?range=${range.q}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const resp = await res.json();
          if (seq !== latSeq) return;
          this.latEnabled = resp.enabled;
          this.latError = "";
          if (!resp.enabled) return;
          // -probe-keep 比所选范围短时，按实际保留时长画，否则左边一大段空白像是监控中断了。
          const changed = setLatency(resp, Math.min(range.sec, resp.keep || range.sec));
          if (changed) {
            // 目标变了：丢掉已不存在的隐藏标记；如果一条可见的都不剩，就全部显示。
            const ids = new Set(lat.series.map((s) => s.id));
            const hidden = Object.fromEntries(Object.entries(this.latHidden).filter(([id, v]) => v && ids.has(id)));
            this.latHidden = lat.series.some((s) => !hidden[s.id]) ? hidden : {};
          }
          this.buildLatBuckets();
          this.latVer++;
          if (changed || !latChart) this.$nextTick(() => this.rebuildLatChart());
          else latChart.u.setData(latData());
        } catch (err) {
          if (seq !== latSeq) return;
          this.latError = this.t("latErr", err.message);
        }
        // 没开启探测就不再轮询；开启后按探测间隔刷新，页面隐藏时停下。
        if ((this.latEnabled || this.latError) && !document.hidden) {
          latTimer = setTimeout(() => this.fetchLatency(), (lat.interval || 60) * 1000);
        }
      },

      setLatRange(r) {
        if (r === this.latRange) return;
        this.latRange = r;
        savePref("lat-range", r);
        this.latHover = null;
        this.fetchLatency();
      },

      rebuildLatChart() {
        buildLatChart(
          this.$refs.latChart,
          (u) => this.onLatCursor(u),
          this.latHidden,
        );
      },

      toggleLat(id) {
        // 至少留一条，全隐藏后图表空白、坐标轴范围也没法算。
        const shown = lat.series.filter((s) => !this.latHidden[s.id]).length;
        if (!this.latHidden[id] && shown <= 1) return;
        this.latHidden = { ...this.latHidden, [id]: !this.latHidden[id] };
        const i = lat.series.findIndex((s) => s.id === id);
        if (latChart && i >= 0) latChart.u.setSeries(i + 1, { show: !this.latHidden[id] });
      },

      // 悬停卡片时高亮对应曲线，其余变淡；隐藏中的曲线不参与。
      focusLat(id) {
        if (!latChart) return;
        const i = lat.series.findIndex((s) => s.id === id);
        latChart.u.setSeries(i >= 0 && !this.latHidden[id] ? i + 1 : null, { focus: true });
      },

      onLatCursor(u) {
        const { idx, left, top } = u.cursor;
        // 光标落在没有数据的区域（窗口左侧还没积累、睡眠断档）时 uPlot 仍会吸附到最近的点，
        // 离得太远就不显示，免得把几小时前的值当成光标处的值。
        const near = idx != null && left >= 0 && lat.t[idx] != null && Math.abs(lat.t[idx] - u.posToVal(left, "x")) <= lat.interval * 2.5;
        this.latHover = near ? idx : null;
        if (!near) {
          this.latTip = null;
          return;
        }
        const x = u.over.offsetLeft + left;
        const y = u.over.offsetTop + top;
        const w = u.root.clientWidth;
        const h = u.root.clientHeight;
        // 靠右或靠下时翻到另一侧，不被图表边缘裁掉。
        this.latTip = { x, y, flipX: x > w * 0.6, flipY: y > h * 0.55 };
      },

      get latTipStyle() {
        const tip = this.latTip;
        if (!tip) return "";
        const tx = tip.flipX ? "calc(-100% - 14px)" : "14px";
        const ty = tip.flipY ? "calc(-100% - 10px)" : "10px";
        return `left: ${tip.x}px; top: ${tip.y}px; transform: translate(${tx}, ${ty})`;
      },

      get latTipTime() {
        const ts = this.latHover == null ? null : lat.t[this.latHover];
        return ts == null ? "" : fmtMdHm(ts);
      },

      // 气泡只列当前显示的曲线；没丢包就不显示丢包，保持紧凑。
      get latTipRows() {
        void this.latVer;
        const h = this.latHover;
        if (h == null) return [];
        return lat.series
          .map((s, i) => ({ s, i }))
          .filter(({ s }) => !this.latHidden[s.id])
          .map(({ s, i }) => {
            const lost = s.lost[h];
            const v = s.p50[h];
            return {
              id: s.id,
              name: s.name,
              color: LAT_COLORS[i % LAT_COLORS.length],
              value: v != null ? `${v.toFixed(1)} ms` : lost != null ? this.t("lat.timeout") : "—",
              bad: v == null && lost != null,
              loss: lost > 0 && v != null ? `${this.t("lat.loss")} ${lost}/${lat.count}` : "",
            };
          });
      },

      // 和 CPU 核心卡片同样的思路：先算一行最多几张，再把各行排均匀，4 张放不下一行时排成 2+2 而不是 3+1。
      latCols(n) {
        const perRow = Math.max(1, Math.floor((this.latGridW + 12) / LAT_TILE_MIN_PX));
        const rows = Math.ceil(n / perRow);
        return Math.max(1, Math.ceil(n / rows));
      },

      buildLatBuckets() {
        this.latBucketRows = lat.summary.map((sum) =>
          sum.buckets.map((b) => ({
            state: b.state,
            color: b.state ? LAT_STATE_COLOR[b.state] : null,
            title: b.state ? this.t("lat.bucketLoss", fmtMdHm(b.t), fmtPct(b.loss)) : this.t("lat.bucketNone", fmtMdHm(b.t)),
          })),
        );
      },

      get latHoverBucket() {
        const h = this.latHover;
        return h != null && lat.t[h] != null ? Math.floor(((lat.t[h] - lat.from) / (lat.to - lat.from)) * LAT_BUCKETS) : -1;
      },

      // 悬停图表时显示该时刻的值；否则显示最新值和整个时间范围的汇总。
      get latRows() {
        void this.latVer;
        const h = this.latHover;
        const ms = (v, d = 1) => (v != null ? `${v.toFixed(d)}` : "—");
        const pct = fmtPct;
        return lat.series.map((s, i) => {
          const sum = lat.summary[i];
          const row = {
            id: s.id,
            name: s.name,
            mode: s.mode,
            addr: s.id.replace(/^tls:/, ""),
            color: LAT_COLORS[i % LAT_COLORS.length],
          };
          if (h != null) {
            const lost = s.lost[h];
            const state = lost == null ? null : lossState(lost, lat.count);
            return {
              ...row,
              value: s.p50[h],
              state,
              stateColor: state && LAT_STATE_COLOR[state],
              stats: [
                [this.t("lat.peak"), ms(s.max[h]), "ms"],
                [this.t("lat.loss"), lost != null ? `${lost}/${lat.count}` : "—", ""],
              ],
            };
          }
          return {
            ...row,
            value: sum.last,
            state: sum.lastState,
            stateColor: sum.lastState && LAT_STATE_COLOR[sum.lastState],
            stats: [
              [this.t("lat.avg"), ms(sum.avg), "ms"],
              [this.t("lat.p95"), ms(sum.p95), "ms"],
              [this.t("lat.jitter"), ms(sum.jitter), "ms"],
              [this.t("lat.loss"), pct(sum.loss), ""],
            ],
          };
        });
      },

      latRanges: Object.keys(LAT_RANGES),

      get latHintText() {
        void this.latVer;
        return this.t("latHint", lat.interval, lat.count);
      },

      get latEmpty() {
        void this.latVer;
        return lat.t.length === 0;
      },

      onMetrics(data) {
        const { soc, ...rest } = data;
        if (soc && !this.soc) this.soc = soc;
        this.multiDie = rest.cpu_tiers?.some((t) => t.cores.some((c) => c.die_id > 0)) ?? false;
        this.m = rest;
        this.corePaths = updateCorePaths(rest);
        this.status = "live";
        this.error = "";
        pushHistory(rest);
        refreshCharts();
      },

      clamp01: (v) => Math.min(1, Math.max(0, v || 0)),
      ratio: (a, b) => (a != null && b > 0 ? Math.min(1, a / b) : 0),

      tierName(label) {
        return ["E", "P", "S", "_"].includes(label) ? this.t(`tier.${label}`) : this.t("tierOther", label);
      },

      // 簇从低到高排列：最低是能效核（E），最高是 cpu 主色，三簇芯片（如 M6）的中间簇用单独的颜色。
      tierColor(ti, n) {
        if (n <= 1) return "cpu";
        if (ti === 0) return "ecpu";
        return ti === n - 1 ? "cpu" : "mcpu";
      },

      coreKey,

      coreName(tier, core) {
        const label = tier.label === "_" ? "C" : tier.label;
        return this.multiDie ? `D${core.die_id}·${label}${core.core_id}` : `${label}${core.core_id}`;
      },

      // 让各行核心数尽量相等：例如 12 核在一行放不下时排成 6+6，而不是 8+4。
      coreCols(n) {
        const perRow = Math.max(1, Math.floor((this.coreGridW + 8) / CORE_CELL_MIN_PX));
        const rows = Math.ceil(n / perRow);
        return Math.max(1, Math.ceil(n / rows));
      },

      // 16 核（M4 Max）以内与内存卡片并排高度接近；更多核心只有 Ultra，单独占一行更紧凑。
      get manyCores() {
        return (this.m?.cpu_tiers ?? []).reduce((n, t) => n + t.cores.length, 0) > 16;
      },

      maxFreq(label) {
        const freqs = this.soc?.cpu_tiers?.find((t) => t.label === label)?.freqs;
        return freqs?.length ? Math.max(...freqs) : 0;
      },

      freqRatio(label, mhz) {
        const max = this.maxFreq(label);
        return max > 0 ? Math.min(1, mhz / max) : 1;
      },

      // 40°C 以下算冷，90°C 以上算热，中间线性过渡，用于图标变色。
      heat: (t) => Math.min(1, Math.max(0, ((t ?? 0) - 40) / 50)),

      get statusMeta() {
        const color = { live: "mem", connecting: "muted", reconnecting: "power", paused: "muted", error: "temp" }[this.status];
        return color ? { text: this.t(`status.${this.status}`), color } : { text: this.status, color: "muted" };
      },

      get metaItems() {
        const s = this.soc;
        const m = this.m;
        const items = [];
        if (s) {
          items.push(s.mac_model);
          const cores = (s.cpu_tiers ?? []).map((t) => `${t.cores}${t.label}`).join(" + ");
          if (cores) items.push(`${cores} CPU`);
          if (s.gpu_cores) items.push(this.t("gpuCores", s.gpu_cores));
          if (s.memory_gb) items.push(`${s.memory_gb} GB`);
        }
        if (m?.uptime != null) {
          const u = m.uptime;
          items.push(this.t("uptime", Math.floor(u / 86400), Math.floor((u % 86400) / 3600), Math.floor((u % 3600) / 60)));
        }
        // 台式机（如 Mac mini）也会上报 0% 且未充电的电池字段，这种情况视为没有电池。
        if (m?.battery_percent != null && (m.battery_percent > 0 || m.battery_charging)) {
          items.push(this.t("battery", m.battery_percent, m.battery_charging));
        }
        return items;
      },

      get gauges() {
        const m = this.m;
        const mem = m?.memory;
        const tiers = m?.cpu_tiers ?? [];
        const memRatio = mem ? this.ratio(mem.ram_usage, mem.ram_total) : null;
        const watts = (v) => (v == null ? "— W" : `${FMT.w(v)} W`);
        return [
          {
            key: "cpu",
            label: "CPU",
            color: "cpu",
            value: m?.cpu_active_ratio,
            display: m ? m.cpu_active_ratio * 100 : null,
            unit: "%",
            lines: [...tiers.map((t) => `${t.label} ${t.freq_mhz} MHz`), watts(m?.cpu_power)],
          },
          {
            key: "gpu",
            label: "GPU",
            color: "gpu",
            value: m?.gpu_active_ratio,
            display: m ? m.gpu_active_ratio * 100 : null,
            unit: "%",
            lines: [m ? `${m.gpu_freq_mhz} MHz` : "— MHz", watts(m?.gpu_power)],
          },
          {
            key: "mem",
            label: this.t("memory"),
            color: "mem",
            value: memRatio,
            display: memRatio == null ? null : memRatio * 100,
            unit: "%",
            lines: mem
              ? [`${FMT.gb(mem.ram_usage)} / ${FMT.gb(mem.ram_total)} GB`, mem.pressure_percent != null ? this.t("pressure", mem.pressure_percent) : ""]
              : ["—"],
          },
          {
            key: "temp",
            label: this.t("temperature"),
            color: "temp",
            value: m?.temp.cpu_temp_avg != null ? m.temp.cpu_temp_avg / 110 : 0,
            display: m?.temp.cpu_temp_avg,
            unit: "°C",
            lines: [
              m?.temp.cpu_temp_avg != null ? `CPU ${FMT.temp(m.temp.cpu_temp_avg)} °C` : "CPU —",
              m?.temp.gpu_temp_avg != null ? `GPU ${FMT.temp(m.temp.gpu_temp_avg)} °C` : "GPU —",
            ],
          },
        ];
      },

      get powerParts() {
        const m = this.m;
        if (!m) return [];
        const parts = [
          { key: "cpu", label: "CPU", color: "cpu", value: m.cpu_power },
          { key: "gpu", label: "GPU", color: "gpu", value: m.gpu_power },
          { key: "ane", label: "ANE", color: "ane", value: m.ane_power },
          { key: "ram", label: this.t("memory"), color: "mem", value: m.ram_power },
        ].filter((p) => p.value != null);
        const sum = parts.reduce((a, p) => a + p.value, 0);
        // 整机功耗中上面几项之外的部分（SSD、外设、供电损耗等），单独列出让总和对得上。
        if (m.sys_power != null && m.sys_power > sum) {
          parts.push({ key: "rest", label: this.t("other"), color: "sys", value: m.sys_power - sum });
        }
        const total = parts.reduce((a, p) => a + p.value, 0) || 1;
        return parts.map((p) => ({ ...p, share: p.value / total }));
      },

      get pressureText() {
        return this.t("pressureLevels")[this.m?.memory.pressure_level] ?? "—";
      },

      get pressureColor() {
        return ["mem", "power", "temp"][this.m?.memory.pressure_level] ?? "mem";
      },

      get ioCards() {
        const m = this.m;
        return [
          { key: "net", label: this.t("network"), nameA: this.t("download"), nameB: this.t("upload"), colorA: "cpu", colorB: "ane", a: m?.net_in, b: m?.net_out },
          { key: "disk", label: this.t("disk"), nameA: this.t("read"), nameB: this.t("write"), colorA: "mem", colorB: "power", a: m?.disk_read, b: m?.disk_write },
        ];
      },

      get temps() {
        const t = this.m?.temp;
        return [
          { key: "cpu", label: this.t("cpuTemp"), value: t?.cpu_temp_avg, icon: "cpu", color: "cpu" },
          { key: "gpu", label: this.t("gpuTemp"), value: t?.gpu_temp_avg, icon: "gpu", color: "gpu" },
        ];
      },
    };
  });
});
