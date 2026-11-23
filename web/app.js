"use strict";

// 按时间而不是点数裁剪：页面隐藏期间不采样，按点数留下的旧数据会把 x 轴拉长到断档之前，
// 新数据被挤到最右边。也让窗口和"最近 5 分钟"的文案在任意 --interval 下都对得上。
const HISTORY_SECONDS = 300;
// 超过这个间隔没数据（页面隐藏、断线）就在曲线上断开，而不是画一条假的连线。
const GAP_SECONDS = 3;
const GB = 1024 ** 3;
const NUM_EASE_MS = 650;
// rAF 跟随显示器刷新率（165Hz 屏上约 160 次/秒），每次改文本都要重排重绘；数字滚动 30fps 已足够顺滑。
const NUM_FRAME_MS = 1000 / 30;
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
  rate: (v) => scaleBytes(v, ["B/s", "KB/s", "MB/s", "GB/s"]),
  bytes: (v) => scaleBytes(v, ["B", "KB", "MB", "GB", "TB"]),
};

// 满 1000 就进位而不是 1024：否则会出现 "1010 KB/s" 这种四位数，撑宽数字栏。
function scaleBytes(v, units) {
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

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
    chipOther: "芯片其他",
    offChip: "芯片外",
    network: "网络",
    download: "下载",
    upload: "上传",
    disk: "磁盘",
    read: "读取",
    write: "写入",
    peak: "峰值",
    windowTotal: "近 5 分钟累计",
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
    "lat.stepHint": (sec) => `图上每点合并 ${sec >= 3600 ? `${sec / 3600} 小时` : `${sec / 60} 分钟`}`,
    "lat.dragHint": "在图上拖动选择时间段放大 · 双击还原",
    "lat.prev": "往前",
    "lat.next": "往后",
    "lat.reset": "退出放大",
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
    chipOther: "Chip other",
    offChip: "Off-chip",
    network: "Network",
    download: "Download",
    upload: "Upload",
    disk: "Disk",
    read: "Read",
    write: "Write",
    peak: "Peak",
    windowTotal: "Last 5 min total",
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
    "lat.stepHint": (sec) => `${sec >= 3600 ? `${sec / 3600} h` : `${sec / 60} min`} per point`,
    "lat.dragHint": "Drag across the chart to zoom · double-click to reset",
    "lat.prev": "Earlier",
    "lat.next": "Later",
    "lat.reset": "Exit zoom",
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
  mountChart(el, opts, data);
}

function mountChart(el, opts, data) {
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

// 镜像图：A 在中轴上方、B 取负画在下方，两半各用一个 scale 独立缩放。
// 下载常比上传大一两个数量级，共用刻度时上传会被压成贴着中轴的一条线；绝对大小看卡片上的数字和峰值标签。
function makeMirrorChart(el, { colors, floor, data }) {
  const line = cssVar("line");
  const half = (key, color, below) => {
    const c = cssVar(color);
    return {
      scale: key,
      stroke: c,
      width: 1.5,
      // fillTo 传数字 0 会被 uPlot 当成未设置而退回 scale 最小值，必须用函数。
      fillTo: () => 0,
      fill: (u) => {
        const mid = u.valToPos(0, key, true);
        const edge = below ? u.bbox.top + u.bbox.height : u.bbox.top;
        const g = u.ctx.createLinearGradient(0, edge, 0, mid);
        g.addColorStop(0, withAlpha(c, 0.3));
        g.addColorStop(1, withAlpha(c, 0.04));
        return g;
      },
      points: { show: false },
      paths: uPlot.paths.spline(),
    };
  };
  // 对称区间让 0 恰好落在正中；留 15% 余量，峰值不顶到边缘。
  const sym = (m) => {
    const r = Math.max(m, floor) * 1.15;
    return [-r, r];
  };
  const opts = {
    width: el.clientWidth || 300,
    height: el.clientHeight || 80,
    padding: [2, 0, 2, 0],
    legend: { show: false },
    cursor: { show: false },
    scales: {
      x: { time: true },
      a: { range: (_, _min, max) => sym(max ?? 0) },
      b: { range: (_, min) => sym(-(min ?? 0)) },
    },
    axes: [{ show: false }, { show: false, scale: "a" }],
    series: [{}, half("a", colors[0], false), half("b", colors[1], true)],
    hooks: {
      draw: [
        (u) => {
          const { ctx, bbox } = u;
          const y = Math.round(u.valToPos(0, "a", true)) + 0.5;
          ctx.save();
          ctx.strokeStyle = line;
          ctx.lineWidth = devicePixelRatio;
          ctx.beginPath();
          ctx.moveTo(bbox.left, y);
          ctx.lineTo(bbox.left + bbox.width, y);
          ctx.stroke();
          ctx.restore();
        },
      ],
    },
  };
  mountChart(el, opts, () => {
    const [t, a, b] = data();
    return [t, a, b.map((v) => (v == null ? null : -v))];
  });
}

// 窗口内峰值和累计量。累计按"速率 × 与上一个点的间隔"积分：每帧速率是上一个采样周期的平均值。
// 窗口第一个点和断档后的第一个点不知道对应多长的周期，宁可少算这一帧也不猜间隔。
function ioWindowStats() {
  const out = {};
  for (const k of ["netIn", "netOut", "diskR", "diskW"]) {
    const v = hist[k];
    let peak = null;
    let total = 0;
    for (let i = 0; i < v.length; i++) {
      if (v[i] == null) continue;
      if (peak == null || v[i] > peak) peak = v[i];
      if (i > 0 && v[i - 1] != null) total += v[i] * (hist.t[i] - hist.t[i - 1]);
    }
    out[k] = peak == null ? null : { peak, total };
  }
  return out;
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
  makeMirrorChart(root.querySelector("[data-spark=net]"), {
    colors: ["cpu", "ane"],
    floor: 1024,
    data: () => [hist.t, hist.netIn, hist.netOut],
  });
  makeMirrorChart(root.querySelector("[data-spark=disk]"), {
    colors: ["mem", "power"],
    floor: 1024,
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
  "30d": { q: "720h", sec: 30 * 86400 },
};
// 不用 mem / power / temp：它们是状态条和状态标签的绿黄红，曲线再用会被误读成状态。
const LAT_COLORS = ["cpu", "gpu", "ane", "ecpu", "mcpu", "sys"];
const LAT_BUCKETS = 40;
// 卡片最小宽度 15rem 加上 gap，用来算一行放几张。
const LAT_TILE_MIN_PX = 240 + 12;
const LAT_STATE_COLOR = { ok: "mem", warn: "power", down: "temp" };
// 与 macmon 帧一样放在 Alpine 之外：7 天 × 每分钟一个点，代理化会很慢。
// summary 在拉取时算好：悬停时 latRows 每次 mousemove 都会重算，不能每次都遍历上万个点。
// step 是每个点代表的秒数：窗口长时服务端会分桶聚合，等于 interval 表示原始数据。
// trendHalf 是当前趋势线滑动窗口的半宽（点数），0 表示不平滑。
const lat = { interval: 60, count: 5, keep: 0, step: 60, from: 0, to: 0, t: [], gaps: [], series: [], summary: [], trendHalf: 0 };
let latChart = null;
// 拖选期间不弹气泡：放在 Alpine 之外，pointermove 时读写不触发响应式。
let latBrushing = false;

const pad2 = (n) => String(n).padStart(2, "0");
const fmtPct = (r) => (r == null ? "—" : `${(r * 100).toFixed(r > 0 && r < 0.01 ? 2 : r >= 0.1 ? 0 : 1)}%`);
const fmtMdHm = (ts) => {
  const d = new Date(ts * 1000);
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const fmtHm = (ts) => {
  const d = new Date(ts * 1000);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
// 同一天只写一次日期：「11/18 03:00 – 09:00」比两个完整时间好读。
const fmtTimeRange = (a, b) =>
  `${fmtMdHm(a)} – ${new Date(a * 1000).toDateString() === new Date(b * 1000).toDateString() ? fmtHm(b) : fmtMdHm(b)}`;
// 与范围按钮（1h / 7d）同一种写法，中英文通用。
const fmtSpan = (sec) => {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
};
// 一个点覆盖的探测次数不多于一轮时按次数显示（2/5），聚合后的点按比例显示。
const fmtLoss = (lost, n) => (n <= lat.count ? `${lost}/${n}` : fmtPct(lost / n));

// 丢包比例 -> 状态。单轮：全丢算中断、丢了一部分算不稳。
// 聚合的一段时间里偶尔丢一次很正常（180 次丢 1 次也才 0.6%），所以低于 2% 仍算正常，否则状态条一片黄。
function lossState(lost, total) {
  if (total <= 0) return null;
  const r = lost / total;
  if (r === 0 || (total > lat.count && r < 0.02)) return "ok";
  return r >= (total > lat.count ? 0.2 : 1) ? "down" : "warn";
}

// 平均 / P95 / 抖动 / 丢包用服务端拿原始数据算好的值：图上的点可能是聚合过的，拿它们再算会把波动抹平。
// 状态条按图上的点分段统计即可，每个点自带探测总数（n），聚合与否都能直接相加。
function summarize(s) {
  const buckets = Array.from({ length: LAT_BUCKETS }, () => ({ lost: 0, total: 0 }));
  const span = lat.to - lat.from;
  for (let i = 0; i < lat.t.length; i++) {
    if (s.lost[i] == null) continue;
    const b = Math.floor(((lat.t[i] - lat.from) / span) * LAT_BUCKETS);
    if (b >= 0 && b < LAT_BUCKETS) {
      buckets[b].lost += s.lost[i];
      buckets[b].total += s.n[i];
    }
  }
  const st = s.stats;
  return {
    avg: st.avg,
    p95: st.p95,
    jitter: st.jitter,
    loss: st.loss,
    last: st.last,
    lastState: st.lastN ? lossState(st.lastLost, st.lastN) : null,
    buckets: buckets.map((b, i) => ({ state: lossState(b.lost, b.total), loss: b.total ? b.lost / b.total : null, t: lat.from + ((i + 0.5) * span) / LAT_BUCKETS })),
  };
}

// 合盖睡眠、服务停机期间没有探测，超过 2.5 个点距就插一个空点让曲线断开，并记下位置供 drawGapBridges 补虚线。
function setLatency(resp) {
  const gap = resp.step * 2.5;
  const t = [];
  const gaps = [];
  // trend 先给空数组：目标增减时旧图要到 $nextTick 才重建，期间的重绘会读到还没算趋势的新 series。
  const series = resp.series.map((s) => ({ id: s.id, name: s.name, mode: s.mode, stats: s.stats, p50: [], max: [], lost: [], n: [], trend: [], lo: null, hi: null }));
  resp.t.forEach((ts, i) => {
    if (t.length && ts - t[t.length - 1] > gap) {
      gaps.push(t.length);
      t.push(t[t.length - 1] + 1);
      for (const s of series) {
        s.p50.push(null);
        s.max.push(null);
        s.lost.push(null);
        s.n.push(null);
      }
    }
    t.push(ts);
    resp.series.forEach((src, si) => {
      series[si].p50.push(src.p50[i]);
      series[si].max.push(src.max[i]);
      series[si].lost.push(src.lost[i]);
      series[si].n.push(src.n[i]);
    });
  });
  for (const s of series) {
    for (const v of s.p50) {
      if (v == null) continue;
      if (s.lo == null || v < s.lo) s.lo = v;
      if (s.hi == null || v > s.hi) s.hi = v;
    }
  }
  const ids = (a) => a.map((s) => s.id).join();
  const changed = ids(series) !== ids(lat.series);
  // x 轴固定为服务端返回的窗口而不是数据范围：数据刚开始积累时一眼能看出只有最近一小段；
  // 窗口已被裁到保留期内，-probe-keep 比所选范围短时左边不会空出一大段像是监控中断。
  Object.assign(lat, { interval: resp.interval, count: resp.count, keep: resp.keep, step: resp.step, from: resp.from, to: resp.to, t, gaps, series });
  lat.summary = series.map(summarize);
  return changed;
}

// 每个趋势点大约覆盖这么多像素。点距超过约 TREND_PX 像素时半宽为 0，即不平滑，放大后自然回到原始数据。
const TREND_PX = 5;
// 绘图区宽度要扣掉 y 轴和右边距，与 buildLatChart 里的 axes size / padding 一致。
const LAT_Y_AXIS_W = 58;
const LAT_PAD = [10, 8, 0, 0];

// width 是整张图的宽度（容器宽度），这里换算成绘图区宽度再算点密度。
function trendHalf(width) {
  const span = lat.to - lat.from;
  const plotW = width - LAT_Y_AXIS_W - LAT_PAD[1] - LAT_PAD[3];
  if (span <= 0 || plotW <= 0) return 0;
  return Math.round((TREND_PX * span) / (plotW * lat.step) / 2);
}

// 滑动中位数：单次尖峰不会把趋势线拉高，持续的抬升仍会跟上；尖峰本身由垫在下面的原始淡线保留。
// 窗口不跨 null（断档、整轮超时），中断处照样断开。两端只取单侧的半个窗口而不是对称收窄到 0，末端不会退化成原始值重新抖起来；
// 代价是最右边 half 个点会随新数据到来修正一次，但只看过去的单侧窗口会让整条线滞后半个窗口、尖峰也跟着右移。
function rollingMedian(vals, half) {
  if (half < 1) return vals;
  const out = new Array(vals.length).fill(null);
  const buf = [];
  for (let i = 0; i < vals.length; i++) {
    if (vals[i] == null) continue;
    buf.length = 0;
    for (let j = i - 1; j >= i - half && vals[j] != null; j--) buf.push(vals[j]);
    for (let j = i; j <= i + half && vals[j] != null; j++) buf.push(vals[j]);
    buf.sort((a, b) => a - b);
    const m = buf.length >> 1;
    out[i] = buf.length % 2 ? buf[m] : (buf[m - 1] + buf[m]) / 2;
  }
  return out;
}

// 平滑窗口按像素定，所以要传图表宽度；宽度变化导致窗口变化时需要重新调用。
function latData(width) {
  lat.trendHalf = trendHalf(width);
  for (const s of lat.series) s.trend = rollingMedian(s.p50, lat.trendHalf);
  return [lat.t, ...lat.series.map((s) => s.trend)];
}

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
const LAT_X_INCRS = [60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 345600, 604800];

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
// 范围按原始值算：曲线是平滑过的，按它定范围会把原始淡线上的尖峰裁到图外。
function latYRange(u, min, max) {
  // 目标增减时 lat 已换成新数据、旧图要到 $nextTick 才重建，下标对不上就只用 uPlot 给的范围。
  if (u.series.length === lat.series.length + 1) {
    lat.series.forEach((s, si) => {
      if (!u.series[si + 1].show || s.lo == null) return;
      min = Math.min(min ?? s.lo, s.lo);
      max = Math.max(max ?? s.hi, s.hi);
    });
  }
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
const fmtMs = (v) => (v == null ? "" : v >= 1000 ? `${+(v / 1000).toFixed(1)} s` : `${+v.toPrecision(3)} ms`);

// 丢包画成底部的细竖条：宽度按一个点距，限制在几像素内并裁到绘图区，点少时也不会糊成一大块。
function drawLoss(u) {
  const { ctx, bbox } = u;
  const dpr = devicePixelRatio;
  const step = u.valToPos(lat.from + lat.step, "x", true) - u.valToPos(lat.from, "x", true);
  const w = Math.min(Math.max(step * 0.8, 2 * dpr), 4 * dpr);
  ctx.save();
  ctx.beginPath();
  ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height);
  ctx.clip();
  ctx.fillStyle = withAlpha(cssVar("temp"), 0.7);
  for (let i = 0; i < lat.t.length; i++) {
    let ratio = 0;
    lat.series.forEach((s, si) => {
      if (u.series[si + 1]?.show && s.lost[i] > 0) ratio = Math.max(ratio, s.lost[i] / s.n[i]);
    });
    if (ratio === 0) continue;
    const x = u.valToPos(lat.t[i], "x", true);
    const h = (3 + ratio * 9) * dpr;
    ctx.fillRect(x - w / 2, bbox.top + bbox.height - h, w, h);
  }
  ctx.restore();
}

// 原始中位数画成淡细线垫在趋势线下面（drawAxes 在画曲线之前触发）：平滑会削掉尖峰，这里把它们留着，
// 也让人看出主线是平滑过的。不平滑时两者重合，不画。
function drawRawLines(u) {
  if (lat.trendHalf < 1 || u.series.length !== lat.series.length + 1) return;
  const { ctx, bbox } = u;
  ctx.save();
  ctx.beginPath();
  ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height);
  ctx.clip();
  ctx.lineWidth = devicePixelRatio;
  ctx.lineJoin = "round";
  lat.series.forEach((s, si) => {
    const us = u.series[si + 1];
    if (!us?.show) return;
    ctx.globalAlpha = 0.3 * us.alpha;
    ctx.strokeStyle = us.stroke(u, si + 1);
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < lat.t.length; i++) {
      const v = s.p50[i];
      if (v == null) {
        pen = false;
        continue;
      }
      const x = u.valToPos(lat.t[i], "x", true);
      const y = u.valToPos(v, "y", true);
      if (pen) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
      pen = true;
    }
    ctx.stroke();
  });
  ctx.restore();
}

// uPlot 的光标圆点按 series 数据（平滑后的趋势）定位，气泡显示的却是原始值；平滑时把圆点挪到原始值上，位置和数字才对得上。
// uPlot 1.6 没有自定义圆点位置的选项，它在触发 setCursor 之前已用 transform 定好位，这里直接覆盖。
function placeRawPoints(u) {
  const i = u.cursor.idx;
  if (lat.trendHalf < 1 || i == null || u.series.length !== lat.series.length + 1) return;
  const x = u.valToPos(lat.t[i], "x");
  lat.series.forEach((s, si) => {
    const v = s.p50[i];
    const el = u.over.querySelector(`.lat-pt-${si}`);
    if (v == null || !el || !u.series[si + 1].show) return;
    el.style.transform = `translate(${x}px,${u.valToPos(v, "y")}px)`;
  });
}

// 没有探测的断档用虚线连起来，免得睡一晚曲线就碎成几截；虚线也表明这段没测，不冒充数据。
// 只连两侧都有延迟值的断档：一侧是全部超时（p50 为 null）时保持断开，"网络不通"是要看见的信号。
function drawGapBridges(u) {
  if (!lat.gaps.length) return;
  const { ctx, bbox } = u;
  const dpr = devicePixelRatio;
  ctx.save();
  ctx.beginPath();
  ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height);
  ctx.clip();
  ctx.lineWidth = 1.25 * dpr;
  ctx.setLineDash([3 * dpr, 4 * dpr]);
  lat.series.forEach((s, si) => {
    const us = u.series[si + 1];
    // 目标增减时 lat 已同步换成新数据，旧图要到 $nextTick 才重建，期间的重绘会多出旧图没有的 series。
    if (!us?.show) return;
    // 跟随 focus 的淡化，悬停其他目标时虚线也一起变淡。
    ctx.globalAlpha = 0.6 * us.alpha;
    ctx.strokeStyle = us.stroke(u, si + 1);
    ctx.beginPath();
    for (const g of lat.gaps) {
      const a = s.trend[g - 1];
      const b = s.trend[g + 1];
      if (a == null || b == null) continue;
      ctx.moveTo(u.valToPos(lat.t[g - 1], "x", true), u.valToPos(a, "y", true));
      ctx.lineTo(u.valToPos(lat.t[g + 1], "x", true), u.valToPos(b, "y", true));
    }
    ctx.stroke();
  });
  ctx.restore();
}

// 拖选时间段放大。没用 uPlot 自带的拖选：要在拖动时实时标出起止时间和时长，松手后还要把选区展开成整个绘图区做过渡。
// 只响应鼠标和触控笔：触屏上横向拖动会和页面滚动、查看气泡冲突，触屏用范围按钮即可。
function attachLatBrush(u, sel, label, cb) {
  const over = u.over;
  const [rangeEl, spanEl] = label.children;
  let x0 = null;
  let picked = null;
  const toX = (e) => Math.min(Math.max(e.clientX - over.getBoundingClientRect().left, 0), over.clientWidth);
  const stop = () => {
    x0 = null;
    picked = null;
    latBrushing = false;
    label.hidden = true;
    window.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => {
    if (e.key !== "Escape") return;
    sel.hidden = true;
    stop();
  };
  over.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.pointerType === "touch" || !lat.t.length) return;
    x0 = toX(e);
    over.setPointerCapture(e.pointerId);
    window.addEventListener("keydown", onKey);
  });
  over.addEventListener("pointermove", (e) => {
    if (x0 == null) return;
    const x1 = toX(e);
    // 几像素内的移动当作点击里的手抖，不弹选区。
    if (!picked && Math.abs(x1 - x0) < 4) return;
    if (!picked) {
      latBrushing = true;
      cb.onStart();
    }
    const a = Math.min(x0, x1);
    const b = Math.max(x0, x1);
    picked = [u.posToVal(a, "x"), u.posToVal(b, "x")];
    sel.classList.remove("is-commit");
    sel.hidden = false;
    Object.assign(sel.style, { left: `${over.offsetLeft + a}px`, top: `${over.offsetTop}px`, width: `${b - a}px`, height: `${over.clientHeight}px` });
    rangeEl.textContent = fmtTimeRange(picked[0], picked[1]);
    spanEl.textContent = fmtSpan(picked[1] - picked[0]);
    label.hidden = false;
    // 标签居中在选区上方，靠近两端时收进绘图区，不被卡片边缘裁掉。
    const lw = label.offsetWidth;
    const cx = over.offsetLeft + (a + b) / 2 - lw / 2;
    label.style.left = `${Math.min(Math.max(cx, over.offsetLeft), over.offsetLeft + over.clientWidth - lw)}px`;
    label.style.top = `${over.offsetTop + 8}px`;
  });
  over.addEventListener("pointerup", () => {
    const p = picked;
    stop();
    if (!p) return;
    // 一次性的过渡（不是每帧数据驱动），动 left / width 的开销可以忽略。
    sel.classList.add("is-commit");
    Object.assign(sel.style, { left: `${over.offsetLeft}px`, width: `${over.clientWidth}px` });
    setTimeout(() => {
      if (sel.classList.contains("is-commit")) sel.hidden = true;
    }, 450);
    cb.onCommit(p[0], p[1]);
  });
  over.addEventListener("pointercancel", () => {
    sel.hidden = true;
    stop();
  });
  over.addEventListener("dblclick", () => cb.onReset());
}

function buildLatChart(el, onHover, hidden, brush) {
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
      padding: LAT_PAD,
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
          size: LAT_Y_AXIS_W,
          gap: 8,
          grid: { stroke: cssVar("line"), width: 1 },
          ticks: { show: false },
          splits: latYSplits,
          // uPlot 对数轴默认会把非 10 的整数次方的刻度过滤成 null（只留 1/10/100），会吃掉 3、30、300 这些自定义刻度。
          filter: (_, splits) => splits,
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
          // 给光标圆点一个可查找的 class，供 placeRawPoints 定位。
          class: `lat-pt-${i}`,
        })),
      ],
      hooks: {
        drawAxes: [drawRawLines],
        draw: [drawGapBridges, drawLoss],
        setCursor: [placeRawPoints, (u) => onHover(u)],
      },
    },
    latData(el.clientWidth || 300),
    el,
  );
  let pending = 0;
  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => {
      if (el.clientWidth > 0 && el.clientHeight > 0) {
        u.setSize({ width: el.clientWidth, height: el.clientHeight });
        if (trendHalf(el.clientWidth) !== lat.trendHalf) u.setData(latData(el.clientWidth));
      }
    });
  });
  ro.observe(el);
  if (brush) attachLatBrush(u, brush.sel, brush.label, brush);
  latChart = { u, ro };
}

const UNSET = Symbol("unset");

document.addEventListener("alpine:init", () => {
  // x-num.<fmt>="expr"：数字变化时缓动过渡，而不是直接跳变。
  Alpine.directive("num", (el, { modifiers, expression }, { evaluateLater, effect, cleanup }) => {
    const get = evaluateLater(expression);
    const fmt = FMT[modifiers[0]] ?? FMT.int;
    let cur = null;
    // 不能用 null 作初值：表达式首次求值常常就是 null（数据未到），会被当成"没变"而跳过，占位符"—"出不来。
    let target = UNSET;
    let shown = null;
    let raf = 0;
    // 每帧都会触发重排重绘，高刷屏上开销按帧率放大：显示的字符串没变就不碰 DOM。
    const show = (s) => {
      if (s !== shown) el.textContent = shown = s;
    };
    effect(() =>
      get((v) => {
        // 每帧数据都会重新求值所有表达式；目标值没变就别重启缓动。
        if (v === target) return;
        target = v;
        cancelAnimationFrame(raf);
        if (v == null || Number.isNaN(v)) {
          cur = null;
          show("—");
          return;
        }
        if (cur == null || reducedMotion.matches || document.hidden) {
          cur = v;
          show(fmt(v));
          return;
        }
        const from = cur;
        const t0 = performance.now();
        let drawn = t0;
        const step = (now) => {
          const k = Math.min(1, (now - t0) / NUM_EASE_MS);
          cur = from + (v - from) * (1 - (1 - k) ** 3);
          if (k === 1 || now - drawn >= NUM_FRAME_MS) {
            drawn = now;
            show(fmt(cur));
          }
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
    let last = 0;
    let raf = 0;
    // 提升为独立合成层：每帧只改 transform 时由合成器旋转，不重绘所在卡片。
    el.style.willChange = "transform";
    const tick = (now) => {
      angle = (angle + (speed * (now - last)) / 1000) % 360;
      last = now;
      el.style.transform = `rotate(${angle}deg)`;
      raf = speed > 0 && !reducedMotion.matches ? requestAnimationFrame(tick) : 0;
    };
    effect(() =>
      get((v) => {
        speed = v > 0 ? 90 + v * 900 : 0;
        // 停转时不留空转的 rAF 循环；重新转起来时从当前时刻计时，避免角度跳变。
        if (!raf && speed > 0 && !reducedMotion.matches) {
          last = performance.now();
          raf = requestAnimationFrame(tick);
        }
      }),
    );
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
      ioStats: {},
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
      // 拖选放大后的绝对时间段 {from, to}（unix 秒）；null 表示跟随范围按钮看到现在。不存偏好：放大是临时查看。
      latZoom: null,
      // 用户主动切换窗口时图表先变淡，新数据到了再恢复，定时刷新不触发。
      latLoading: false,

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
        // 推到下一帧再改：列数变化会改变卡片布局，在回调里同步改会触发 "ResizeObserver loop" 报错。
        let latGridRaf = 0;
        new ResizeObserver(([entry]) => {
          cancelAnimationFrame(latGridRaf);
          latGridRaf = requestAnimationFrame(() => {
            this.latGridW = entry.contentRect.width;
          });
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
          const z = this.latZoom;
          const res = await fetch(z ? `api/latency?from=${z.from}&to=${z.to}` : `api/latency?range=${LAT_RANGES[this.latRange].q}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const resp = await res.json();
          if (seq !== latSeq) return;
          this.latEnabled = resp.enabled;
          this.latError = "";
          if (!resp.enabled) return;
          const changed = setLatency(resp);
          // 偏好里存的范围超过了 -probe-keep 时按钮已被隐藏，高亮改到最长的那个（服务端本来就按保留期裁过窗口）。
          if (!this.latRanges.includes(this.latRange)) this.latRange = this.latRanges.at(-1);
          if (changed) {
            // 目标变了：丢掉已不存在的隐藏标记；如果一条可见的都不剩，就全部显示。
            const ids = new Set(lat.series.map((s) => s.id));
            const hidden = Object.fromEntries(Object.entries(this.latHidden).filter(([id, v]) => v && ids.has(id)));
            this.latHidden = lat.series.some((s) => !hidden[s.id]) ? hidden : {};
          }
          this.buildLatBuckets();
          this.latVer++;
          if (changed || !latChart) this.$nextTick(() => this.rebuildLatChart());
          else latChart.u.setData(latData(latChart.u.width));
        } catch (err) {
          if (seq !== latSeq) return;
          this.latError = this.t("latErr", err.message);
        }
        this.latLoading = false;
        // 没开启探测就不再轮询；开启后按探测间隔刷新，页面隐藏时停下。放大看的是过去固定的一段，不用刷新。
        if ((this.latEnabled || this.latError) && !document.hidden && !this.latZoom) {
          latTimer = setTimeout(() => this.fetchLatency(), (lat.interval || 60) * 1000);
        }
      },

      // 放大状态下点当前高亮的按钮也要生效：作用是退出放大回到实时。
      setLatRange(r) {
        if (r === this.latRange && !this.latZoom) return;
        this.latRange = r;
        savePref("lat-range", r);
        this.latZoom = null;
        this.reloadLatency();
      },

      reloadLatency() {
        this.latHover = null;
        this.latTip = null;
        this.latLoading = true;
        this.fetchLatency();
      },

      // 选得太窄时以中心扩到最小跨度：每个状态条分段至少要有一个点，否则状态条一半是"无数据"。
      zoomLat(from, to) {
        const now = Date.now() / 1000;
        const minSpan = LAT_BUCKETS * lat.interval;
        if (to - from < minSpan) {
          const c = (from + to) / 2;
          from = c - minSpan / 2;
          to = c + minSpan / 2;
        }
        if (to > now) {
          from -= to - now;
          to = now;
        }
        from = Math.max(from, now - lat.keep);
        this.latZoom = { from: Math.floor(from), to: Math.ceil(to) };
        this.reloadLatency();
      },

      // 每次平移半个窗口，前后两屏有一半重叠，不会看漏跨在边界上的波动。
      panLat(dir) {
        const z = this.latZoom;
        if (!z) return;
        const span = z.to - z.from;
        const now = Date.now() / 1000;
        const from = Math.min(Math.max(z.from + (dir * span) / 2, now - lat.keep), now - span);
        this.latZoom = { from: Math.floor(from), to: Math.floor(from) + span };
        this.reloadLatency();
      },

      resetLatZoom() {
        if (!this.latZoom) return;
        this.latZoom = null;
        this.reloadLatency();
      },

      get latPan() {
        void this.latVer;
        const z = this.latZoom;
        if (!z) return { prev: false, next: false };
        const now = Date.now() / 1000;
        return { prev: z.from > now - lat.keep + lat.interval, next: z.to < now - lat.interval };
      },

      get latZoomText() {
        const z = this.latZoom;
        return z ? fmtTimeRange(z.from, z.to) : "";
      },

      get latZoomSpan() {
        const z = this.latZoom;
        return z ? fmtSpan(z.to - z.from) : "";
      },

      rebuildLatChart() {
        buildLatChart(this.$refs.latChart, (u) => this.onLatCursor(u), this.latHidden, {
          sel: this.$refs.latSel,
          label: this.$refs.latSelLabel,
          onStart: () => {
            this.latHover = null;
            this.latTip = null;
          },
          onCommit: (from, to) => this.zoomLat(from, to),
          onReset: () => this.resetLatZoom(),
        });
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
        const near = !latBrushing && idx != null && left >= 0 && lat.t[idx] != null && Math.abs(lat.t[idx] - u.posToVal(left, "x")) <= lat.step * 2.5;
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

      // 聚合的点显示它覆盖的整段时间：只写一个时刻会让人以为那是某一轮的值。
      get latTipTime() {
        const ts = this.latHover == null ? null : lat.t[this.latHover];
        if (ts == null) return "";
        if (lat.step <= lat.interval) return fmtMdHm(ts);
        const start = ts - (ts % lat.step);
        return fmtTimeRange(start, start + lat.step);
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
              loss: lost > 0 && v != null ? `${this.t("lat.loss")} ${fmtLoss(lost, s.n[h])}` : "",
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
            const state = lost == null ? null : lossState(lost, s.n[h]);
            return {
              ...row,
              value: s.p50[h],
              state,
              stateColor: state && LAT_STATE_COLOR[state],
              stats: [
                [this.t("lat.peak"), ms(s.max[h]), "ms"],
                [this.t("lat.loss"), lost != null ? fmtLoss(lost, s.n[h]) : "—", ""],
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

      // 只列保留期内看得全的范围，再加一个刚好覆盖保留期的：保留 7 天时 30d 和 7d 看到的一样，留着只会让人困惑。
      get latRanges() {
        void this.latVer;
        const keys = Object.keys(LAT_RANGES);
        const i = lat.keep ? keys.findIndex((k) => LAT_RANGES[k].sec >= lat.keep * 0.99) : -1;
        return i < 0 ? keys : keys.slice(0, i + 1);
      },

      get latHintText() {
        void this.latVer;
        const base = this.t("latHint", lat.interval, lat.count);
        return lat.step > lat.interval ? `${base} · ${this.t("lat.stepHint", lat.step)}` : base;
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
        this.ioStats = ioWindowStats();
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
        if (m.chip_power == null) {
          // 没有芯片总功耗就分不出芯片内外，退回一个笼统的"其余"，免得把芯片内的部分标成芯片外。
          if (m.sys_power != null && m.sys_power > sum) {
            parts.push({ key: "rest", label: this.t("other"), color: "sys", value: m.sys_power - sum });
          }
        } else {
          // 拆成两段而不是一个"其余"：卡片大数字是芯片功耗，芯片内各项要能加到它；
          // 芯片外（SSD、屏幕、供电损耗等）再补到整机，和顶部整机功耗对上。
          // 差值钳到 0 但始终保留这两项：采样错位时差值会在 0 附近来回，项数一变网格和比例条就跳。
          parts.push({ key: "chipOther", label: this.t("chipOther"), color: "sys", value: Math.max(0, m.chip_power - sum) });
          if (m.sys_power != null) {
            parts.push({ key: "offChip", label: this.t("offChip"), color: "sys", dim: true, value: Math.max(0, m.sys_power - m.chip_power) });
          }
        }
        const total = parts.reduce((a, p) => a + p.value, 0) || 1;
        return parts.map((p) => ({
          ...p,
          share: p.value / total,
          // 芯片外用斜纹而不是降低透明度：浅色主题下半透明灰和空轨道几乎分不出来。
          bg: p.dim ? `repeating-linear-gradient(-45deg, var(--${p.color}) 0 2px, transparent 2px 4px)` : `var(--${p.color})`,
        }));
      },

      get pressureText() {
        return this.t("pressureLevels")[this.m?.memory.pressure_level] ?? "—";
      },

      get pressureColor() {
        return ["mem", "power", "temp"][this.m?.memory.pressure_level] ?? "mem";
      },

      get ioCards() {
        const m = this.m;
        const st = this.ioStats;
        const peak = (s) => `${this.t("peak")} ${s ? FMT.rate(s.peak) : "—"}`;
        const total = (s) => (s ? FMT.bytes(s.total) : "—");
        return [
          { key: "net", label: this.t("network"), nameA: this.t("download"), nameB: this.t("upload"), colorA: "cpu", colorB: "ane", a: m?.net_in, b: m?.net_out, sA: st.netIn, sB: st.netOut },
          { key: "disk", label: this.t("disk"), nameA: this.t("read"), nameB: this.t("write"), colorA: "mem", colorB: "power", a: m?.disk_read, b: m?.disk_write, sA: st.diskR, sB: st.diskW },
        ].map((c) => ({ ...c, peakA: peak(c.sA), peakB: peak(c.sB), totalA: total(c.sA), totalB: total(c.sB) }));
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
