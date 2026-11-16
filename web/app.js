"use strict";

const HISTORY_POINTS = 300;
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

function formatUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `已运行 ${d} 天 ${h} 小时`;
  if (h > 0) return `已运行 ${h} 小时 ${m} 分`;
  return `已运行 ${m} 分`;
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
  while (hist.t.length > HISTORY_POINTS) {
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

    return {
      m: null,
      soc: null,
      corePaths: {},
      coreGridW: 0,
      multiDie: false,
      status: "connecting",
      error: "",

      init() {
        this.$nextTick(() => buildCharts(this.$root));
        new ResizeObserver(([entry]) => {
          this.coreGridW = entry.contentRect.width;
        }).observe(this.$refs.coreCard);
        // 在后台标签页打开（或恢复会话）时不会触发 visibilitychange，需要在这里就判断。
        if (document.hidden) this.status = "paused";
        else this.connect();
        document.addEventListener("visibilitychange", () => {
          if (document.hidden) this.disconnect();
          else this.connect();
        });
        // 切换系统深浅色时图表颜色来自 CSS 变量，需要重建。
        window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
          buildCharts(this.$root);
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
            this.error = `数据解析失败：${err.message}`;
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
        return { E: "能效核心", P: "性能核心", S: "超级核心", _: "CPU 核心" }[label] ?? `${label} 核心`;
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
        return (
          {
            live: { text: "实时", color: "mem" },
            connecting: { text: "连接中", color: "muted" },
            reconnecting: { text: "重连中", color: "power" },
            paused: { text: "已暂停", color: "muted" },
            error: { text: "错误", color: "temp" },
          }[this.status] ?? { text: this.status, color: "muted" }
        );
      },

      get metaItems() {
        const s = this.soc;
        const m = this.m;
        const items = [];
        if (s) {
          items.push(s.mac_model);
          const cores = (s.cpu_tiers ?? []).map((t) => `${t.cores}${t.label}`).join(" + ");
          if (cores) items.push(`${cores} CPU`);
          if (s.gpu_cores) items.push(`${s.gpu_cores} 核 GPU`);
          if (s.memory_gb) items.push(`${s.memory_gb} GB`);
        }
        if (m?.uptime != null) items.push(formatUptime(m.uptime));
        // 台式机（如 Mac mini）也会上报 0% 且未充电的电池字段，这种情况视为没有电池。
        if (m?.battery_percent != null && (m.battery_percent > 0 || m.battery_charging)) {
          items.push(`电池 ${m.battery_percent}%${m.battery_charging ? " · 充电中" : ""}`);
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
            label: "内存",
            color: "mem",
            value: memRatio,
            display: memRatio == null ? null : memRatio * 100,
            unit: "%",
            lines: mem
              ? [`${FMT.gb(mem.ram_usage)} / ${FMT.gb(mem.ram_total)} GB`, mem.pressure_percent != null ? `压力 ${mem.pressure_percent}%` : ""]
              : ["—"],
          },
          {
            key: "temp",
            label: "温度",
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
          { key: "ram", label: "内存", color: "mem", value: m.ram_power },
        ].filter((p) => p.value != null);
        const sum = parts.reduce((a, p) => a + p.value, 0);
        // 整机功耗中上面几项之外的部分（SSD、外设、供电损耗等），单独列出让总和对得上。
        if (m.sys_power != null && m.sys_power > sum) {
          parts.push({ key: "rest", label: "其余", color: "sys", value: m.sys_power - sum });
        }
        const total = parts.reduce((a, p) => a + p.value, 0) || 1;
        return parts.map((p) => ({ ...p, share: p.value / total }));
      },

      get pressureText() {
        return ["正常", "警告", "严重"][this.m?.memory.pressure_level] ?? "—";
      },

      get pressureColor() {
        return ["mem", "power", "temp"][this.m?.memory.pressure_level] ?? "mem";
      },

      get ioCards() {
        const m = this.m;
        return [
          { key: "net", label: "网络", nameA: "下载", nameB: "上传", colorA: "cpu", colorB: "ane", a: m?.net_in, b: m?.net_out },
          { key: "disk", label: "磁盘", nameA: "读取", nameB: "写入", colorA: "mem", colorB: "power", a: m?.disk_read, b: m?.disk_write },
        ];
      },

      get temps() {
        const t = this.m?.temp;
        return [
          { label: "CPU 温度", value: t?.cpu_temp_avg, icon: "cpu", color: "cpu" },
          { label: "GPU 温度", value: t?.gpu_temp_avg, icon: "gpu", color: "gpu" },
        ];
      },
    };
  });
});
