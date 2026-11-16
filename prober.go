package main

import (
	"bufio"
	"bytes"
	"cmp"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	// 单次探测只看一次 connect 会把偶发抖动当成网络变差，所以每轮连测几次取中位数。
	probeCount   = 5
	probeGap     = 200 * time.Millisecond
	probeTimeout = 2 * time.Second
	// 每轮最坏耗时 = 解析 + count*(timeout+gap)，间隔不能比它短，否则轮次会重叠。
	minProbeInterval = 15 * time.Second
	compactEvery     = 24 * time.Hour
)

// 两种模式对应两种"真实延迟"：
//   - direct：socket 绑定物理网卡绕过 TUN 代理，测宽带线路本身的 TCP 握手 RTT。
//     TUN 代理会在本地直接完成握手，不绑网卡测到的只是本机到代理进程的耗时。
//   - tls：照常走系统路由（经过代理），计时到 TLS 握手完成，反映实际上网体验，含代理节点耗时。
const (
	modeDirect = "direct"
	modeTLS    = "tls"
)

type probeTarget struct {
	ID   string // [tls:]host:port，作为历史数据的键：改显示名不丢历史，换模式则是另一条曲线
	Name string
	Mode string
	Host string
	Port string
}

// probeResult 中 P50/Min/Max 单位为毫秒；全部失败时为 nil，前端据此断开曲线而不是画 0。
type probeResult struct {
	P50  *float64 `json:"p50"`
	Min  *float64 `json:"min"`
	Max  *float64 `json:"max"`
	Lost int      `json:"lost"`
	N    int      `json:"n"`
}

// probeCycle 是一轮探测：所有目标共用同一个时间戳，图表才能共享 x 轴。
type probeCycle struct {
	T int64                  `json:"t"`
	R map[string]probeResult `json:"r"`
}

// Prober 在后台定时对目标做 TCP connect 计时，不依赖页面是否打开，历史以 JSON Lines 追加落盘。
type Prober struct {
	targets  []probeTarget
	interval time.Duration
	keep     time.Duration
	path     string

	mu     sync.Mutex
	cycles []probeCycle
	file   *os.File

	// 以下只在 Run 协程里读写。物理链路和目标的状态每轮都会更新，只在变化时记日志，免得每分钟刷一条。
	lastLink string
	down     map[string]bool
}

// parseProbeTargets 解析 "[tls:][名称=]host:port,..."。
func parseProbeTargets(spec string) ([]probeTarget, error) {
	var out []probeTarget
	seen := map[string]bool{}
	for _, item := range strings.Split(spec, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		mode := modeDirect
		rest := item
		if r, ok := strings.CutPrefix(item, "tls:"); ok {
			mode, rest = modeTLS, r
		}
		name, addr, hasName := strings.Cut(rest, "=")
		if !hasName {
			addr = name
		}
		name, addr = strings.TrimSpace(name), strings.TrimSpace(addr)
		host, port, err := net.SplitHostPort(addr)
		if err != nil || host == "" || port == "" {
			return nil, fmt.Errorf("invalid probe target %q: want [tls:][name=]host:port", item)
		}
		// direct 只能绑 IPv4 网卡（IP_BOUND_IF），IPv6 字面量会每轮 100% 丢包且只有 Debug 日志，不如启动时就报错。
		if a, err := netip.ParseAddr(host); err == nil && mode == modeDirect && !a.Unmap().Is4() {
			return nil, fmt.Errorf("invalid probe target %q: direct mode is IPv4 only, use tls: for IPv6", item)
		}
		id := net.JoinHostPort(host, port)
		if mode == modeTLS {
			id = "tls:" + id
		}
		if seen[id] {
			return nil, fmt.Errorf("duplicate probe target %q", id)
		}
		seen[id] = true
		if name == "" {
			name = id
		}
		out = append(out, probeTarget{ID: id, Name: name, Mode: mode, Host: host, Port: port})
	}
	if len(out) == 0 {
		return nil, errors.New("no probe targets")
	}
	return out, nil
}

func NewProber(targets []probeTarget, interval, keep time.Duration, path string) (*Prober, error) {
	if interval < minProbeInterval {
		return nil, fmt.Errorf("probe interval %s is shorter than %s", interval, minProbeInterval)
	}
	if keep < interval {
		return nil, fmt.Errorf("probe keep %s is shorter than probe interval %s", keep, interval)
	}
	return &Prober{targets: targets, interval: interval, keep: keep, path: path, down: map[string]bool{}}, nil
}

// Run 阻塞直到 ctx 结束。落盘失败只记日志并退化为纯内存，不影响探测本身。
func (p *Prober) Run(ctx context.Context) {
	// 读历史失败时不能 compact：内存里是空的，compact 会用空文件把磁盘上的完整历史替换掉。
	if err := p.load(); err != nil {
		slog.Warn("load probe history, starting empty and appending without compaction", "path", p.path, "err", err)
		p.openAppend()
	} else if err := p.compact(); err != nil {
		// 目录暂时不可写时文件本身可能仍可追加，别等到 24h 后下次 compact 才恢复落盘。
		slog.Warn("compact probe history, appending to existing file", "path", p.path, "err", err)
		p.openAppend()
	}
	defer p.closeFile()
	slog.Info("prober started", "targets", len(p.targets), "interval", p.interval, "keep", p.keep, "path", p.path)

	tick := time.NewTicker(p.interval)
	defer tick.Stop()
	lastCompact := time.Now()
	for {
		c := p.probeAll(ctx)
		// 退出时被打断的这一轮全是失败，记下来会在每次重启处留一个假的丢包点。
		if ctx.Err() != nil {
			return
		}
		p.record(c)
		if time.Since(lastCompact) >= compactEvery {
			lastCompact = time.Now()
			if err := p.compact(); err != nil {
				slog.Warn("compact probe history", "err", err)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

func (p *Prober) probeAll(ctx context.Context) probeCycle {
	var link *physLink
	var linkErr error
	if slices.ContainsFunc(p.targets, func(t probeTarget) bool { return t.Mode == modeDirect }) {
		// 每轮重新查：Wi-Fi 和有线切换、换网络后物理网卡和 DNS 都会变。
		link, linkErr = findPhysLink(ctx)
		var msg string
		if linkErr != nil {
			msg = "err:" + linkErr.Error()
		} else {
			msg = link.name + "/" + link.dns
		}
		if msg != p.lastLink {
			if linkErr != nil {
				slog.Warn("direct probes disabled: no physical link", "err", linkErr)
			} else {
				slog.Info("direct probes use physical link", "iface", link.name, "dns", link.dns)
			}
			p.lastLink = msg
		}
	}

	c := probeCycle{T: time.Now().Unix(), R: make(map[string]probeResult, len(p.targets))}
	errs := make(map[string]error, len(p.targets))
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, t := range p.targets {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var r probeResult
			var err error
			if t.Mode == modeDirect && link == nil {
				r, err = probeResult{Lost: probeCount, N: probeCount}, linkErr
			} else {
				r, err = probeOne(ctx, t, link)
			}
			mu.Lock()
			c.R[t.ID] = r
			errs[t.ID] = err
			mu.Unlock()
		}()
	}
	wg.Wait()
	if ctx.Err() == nil {
		p.logTransitions(c, errs)
	}
	return c
}

// logTransitions 只在目标"全部失败"和"恢复"之间切换时记日志：图上只看得到丢包，看不到原因。
func (p *Prober) logTransitions(c probeCycle, errs map[string]error) {
	for _, t := range p.targets {
		down := c.R[t.ID].Lost == probeCount
		if down == p.down[t.ID] {
			continue
		}
		p.down[t.ID] = down
		if down {
			slog.Warn("probe target unreachable", "target", t.ID, "err", errs[t.ID])
		} else {
			slog.Info("probe target recovered", "target", t.ID)
		}
	}
}

// probeOne 的 error 是最后一次失败的原因，仅供日志使用；结果里的丢包数才是数据。
func probeOne(ctx context.Context, t probeTarget, link *physLink) (probeResult, error) {
	r := probeResult{N: probeCount}
	// 每轮先解析一次再连 IP：否则 DNS 耗时会混进延迟里，而且每次连接都可能落到不同的 IP。
	var addr netip.Addr
	var err error
	if t.Mode == modeDirect {
		addr, err = resolve(ctx, link.resolver(), "ip4", t.Host)
	} else {
		addr, err = resolve(ctx, net.DefaultResolver, "ip", t.Host)
	}
	if err != nil {
		r.Lost = probeCount
		return r, fmt.Errorf("resolve: %w", err)
	}
	dst := net.JoinHostPort(addr.String(), t.Port)
	var rtts []float64
	var lastErr error
	for i := range probeCount {
		if i > 0 {
			select {
			case <-ctx.Done():
				r.Lost += probeCount - i
				return finish(r, rtts), ctx.Err()
			case <-time.After(probeGap):
			}
		}
		var rtt time.Duration
		if t.Mode == modeDirect {
			rtt, err = dialOnce(ctx, link.dialer(), dst)
		} else {
			rtt, err = tlsOnce(ctx, dst, t.Host)
		}
		if err != nil {
			lastErr = err
			r.Lost++
			continue
		}
		rtts = append(rtts, float64(rtt.Microseconds())/1000)
	}
	return finish(r, rtts), lastErr
}

func dialOnce(ctx context.Context, d *net.Dialer, dst string) (time.Duration, error) {
	start := time.Now()
	conn, err := d.DialContext(ctx, "tcp4", dst)
	if err != nil {
		return 0, err
	}
	rtt := time.Since(start)
	return rtt, conn.Close()
}

func tlsOnce(ctx context.Context, dst, serverName string) (time.Duration, error) {
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	d := tls.Dialer{Config: &tls.Config{
		ServerName: serverName,
		// 只计时握手、不传任何数据，证书是否可信与延迟无关；校验反而会让 IP 目标或自签证书全算丢包。
		InsecureSkipVerify: true,
		// 不设 ClientSessionCache：每次都完整握手，避免会话复用让后几次明显偏快。
	}}
	start := time.Now()
	conn, err := d.DialContext(ctx, "tcp", dst)
	if err != nil {
		return 0, err
	}
	rtt := time.Since(start)
	return rtt, conn.Close()
}

func resolve(ctx context.Context, res *net.Resolver, network, host string) (netip.Addr, error) {
	if a, err := netip.ParseAddr(host); err == nil {
		return a.Unmap(), nil
	}
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	addrs, err := res.LookupNetIP(ctx, network, host)
	if err != nil {
		return netip.Addr{}, err
	}
	if len(addrs) == 0 {
		return netip.Addr{}, fmt.Errorf("no address for %s", host)
	}
	// 优先 IPv4：不少家庭网络 IPv6 路由质量差或不通，混用会让曲线在两条路径间跳。
	for _, a := range addrs {
		if a.Unmap().Is4() {
			return a.Unmap(), nil
		}
	}
	return addrs[0], nil
}

// physLink 是绕过 TUN 用的物理网卡及其 DNS。direct 模式只支持 IPv4（IP_BOUND_IF）。
type physLink struct {
	name  string
	index int
	dns   string
}

// findPhysLink 从路由表里找第一条非 utun 的 interface-scoped default 路由。
// 开着 TUN 代理时系统主接口（PrimaryInterface）就是 utun，不能用；物理网卡的 scoped 路由仍在。
func findPhysLink(ctx context.Context) (*physLink, error) {
	out, err := exec.CommandContext(ctx, "netstat", "-rn", "-f", "inet").Output()
	if err != nil {
		return nil, fmt.Errorf("netstat: %w", err)
	}
	for _, line := range strings.Split(string(out), "\n") {
		f := strings.Fields(line)
		if len(f) < 4 || f[0] != "default" || strings.HasPrefix(f[3], "utun") {
			continue
		}
		gw, err := netip.ParseAddr(f[1])
		if err != nil || !gw.Is4() {
			continue
		}
		iface, err := net.InterfaceByName(f[3])
		if err != nil {
			return nil, err
		}
		return &physLink{name: iface.Name, index: iface.Index, dns: physDNS(ctx, iface.Name, gw)}, nil
	}
	return nil, errors.New("no non-tunnel default route")
}

// physDNS 取该网卡 DHCP 下发的 DNS，没有（手动配置 IP 等）就退回网关。
// 不能用系统 DNS：TUN 代理的 fake-ip 模式会返回 198.18.x.x 这类假地址，绕过代理后连不上。
func physDNS(ctx context.Context, iface string, gw netip.Addr) string {
	out, err := exec.CommandContext(ctx, "ipconfig", "getoption", iface, "domain_name_server").Output()
	if err == nil {
		if a, err := netip.ParseAddr(strings.TrimSpace(string(out))); err == nil {
			return a.String()
		}
	}
	return gw.String()
}

func (l *physLink) dialer() *net.Dialer {
	return &net.Dialer{
		Timeout: probeTimeout,
		Control: func(_, _ string, c syscall.RawConn) error {
			var serr error
			if err := c.Control(func(fd uintptr) {
				serr = syscall.SetsockoptInt(int(fd), syscall.IPPROTO_IP, syscall.IP_BOUND_IF, l.index)
			}); err != nil {
				return err
			}
			return serr
		},
	}
}

func (l *physLink) resolver() *net.Resolver {
	d := l.dialer()
	server := net.JoinHostPort(l.dns, "53")
	return &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return d.DialContext(ctx, network+"4", server)
		},
	}
}

func finish(r probeResult, rtts []float64) probeResult {
	if len(rtts) == 0 {
		return r
	}
	slices.Sort(rtts)
	mid := len(rtts) / 2
	p50 := rtts[mid]
	if len(rtts)%2 == 0 {
		p50 = (rtts[mid-1] + rtts[mid]) / 2
	}
	lo, hi := rtts[0], rtts[len(rtts)-1]
	r.P50, r.Min, r.Max = &p50, &lo, &hi
	return r
}

func (p *Prober) record(c probeCycle) {
	if len(c.R) == 0 {
		return
	}
	line, err := json.Marshal(c)
	if err != nil {
		slog.Error("marshal probe cycle", "err", err)
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	// 运行中时钟被回拨时按时间插入，裁剪和 Snapshot 的二分查找都依赖有序。
	i, _ := slices.BinarySearchFunc(p.cycles, c.T, func(e probeCycle, t int64) int {
		if e.T <= t {
			return -1
		}
		return 1
	})
	p.cycles = slices.Insert(p.cycles, i, c)
	p.pruneLocked(time.Now())
	if p.file != nil {
		if _, err := p.file.Write(append(line, '\n')); err != nil {
			slog.Warn("append probe history", "err", err)
		}
	}
}

func (p *Prober) pruneLocked(now time.Time) {
	cutoff := now.Add(-p.keep).Unix()
	i := sort.Search(len(p.cycles), func(i int) bool { return p.cycles[i].T >= cutoff })
	if i > 0 {
		p.cycles = slices.Delete(p.cycles, 0, i)
	}
}

func (p *Prober) load() error {
	f, err := os.Open(p.path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	var cycles []probeCycle
	bad := 0
	// 用 ReadBytes 而不是 Scanner：Scanner 遇到超长的坏行会直接报错，一行损坏就让整份历史读不出来。
	r := bufio.NewReader(f)
	for {
		line, err := r.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) > 0 {
			var c probeCycle
			// 进程被强杀时最后一行可能只写了一半，跳过即可，compact 会把它清掉。
			if jerr := json.Unmarshal(line, &c); jerr != nil || c.T == 0 {
				bad++
			} else {
				cycles = append(cycles, c)
			}
		}
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return err
		}
	}
	if bad > 0 {
		slog.Warn("skipped corrupt probe history lines", "count", bad)
	}
	// 系统时钟被回拨时追加的行可能乱序，二分裁剪依赖有序。
	slices.SortStableFunc(cycles, func(a, b probeCycle) int { return cmp.Compare(a.T, b.T) })
	p.mu.Lock()
	p.cycles = cycles
	p.pruneLocked(time.Now())
	p.mu.Unlock()
	return nil
}

// compact 把内存里保留期内的数据重写成新文件再原子替换，避免追加文件无限增长。
// 新文件写好、替换成功后才切换追加句柄：中途失败时继续往旧文件追加，不会因为一次整理失败就停止落盘。
func (p *Prober) compact() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.pruneLocked(time.Now())
	if err := os.MkdirAll(filepath.Dir(p.path), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(p.path), ".latency-*.tmp")
	if err != nil {
		return err
	}
	w := bufio.NewWriter(tmp)
	enc := json.NewEncoder(w)
	for _, c := range p.cycles {
		if err = enc.Encode(c); err != nil {
			break
		}
	}
	if err == nil {
		err = w.Flush()
	}
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp.Name(), p.path)
	}
	if err != nil {
		if rmErr := os.Remove(tmp.Name()); rmErr != nil && !errors.Is(rmErr, fs.ErrNotExist) {
			slog.Warn("remove temp probe history", "err", rmErr)
		}
		return err
	}
	// 旧句柄指向被替换掉的 inode，继续写会丢数据，必须换成新文件。
	if p.file != nil {
		if err := p.file.Close(); err != nil {
			slog.Warn("close probe history", "err", err)
		}
		p.file = nil
	}
	p.file, err = os.OpenFile(p.path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o644)
	return err
}

// openAppend 在 compact 走不通时退而求其次直接追加；仍失败就只保留内存数据。
func (p *Prober) openAppend() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.file != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(p.path), 0o755); err != nil {
		slog.Warn("probe history will not be persisted", "path", p.path, "err", err)
		return
	}
	f, err := os.OpenFile(p.path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o644)
	if err != nil {
		slog.Warn("probe history will not be persisted", "path", p.path, "err", err)
		return
	}
	p.file = f
}

func (p *Prober) closeFile() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.file == nil {
		return
	}
	if err := p.file.Close(); err != nil {
		slog.Warn("close probe history", "err", err)
	}
	p.file = nil
}

type latencySeries struct {
	ID   string     `json:"id"`
	Name string     `json:"name"`
	Mode string     `json:"mode"`
	P50  []*float64 `json:"p50"`
	Max  []*float64 `json:"max"`
	Lost []*int     `json:"lost"`
}

type latencyResponse struct {
	Enabled  bool    `json:"enabled"`
	Interval float64 `json:"interval,omitempty"`
	Count    int     `json:"count,omitempty"`
	Keep     float64 `json:"keep,omitempty"`
	// 窗口内没有数据时也输出空数组而不是省略字段，客户端不用判断字段是否存在。
	T      []int64         `json:"t"`
	Series []latencySeries `json:"series"`
}

// Snapshot 返回最近 window 内的列式数据，直接对应 uPlot 的 data 结构。
// 只输出当前配置的目标：历史文件里已删除的目标不再显示，但数据留到过期自然清掉。
func (p *Prober) Snapshot(window time.Duration) latencyResponse {
	window = min(window, p.keep)
	cutoff := time.Now().Add(-window).Unix()

	p.mu.Lock()
	i := sort.Search(len(p.cycles), func(i int) bool { return p.cycles[i].T >= cutoff })
	cycles := p.cycles[i:]
	resp := latencyResponse{
		Enabled:  true,
		Interval: p.interval.Seconds(),
		Count:    probeCount,
		Keep:     p.keep.Seconds(),
		T:        make([]int64, len(cycles)),
		Series:   make([]latencySeries, len(p.targets)),
	}
	for si, t := range p.targets {
		resp.Series[si] = latencySeries{
			ID:   t.ID,
			Name: t.Name,
			Mode: t.Mode,
			P50:  make([]*float64, len(cycles)),
			Max:  make([]*float64, len(cycles)),
			Lost: make([]*int, len(cycles)),
		}
	}
	for ci, c := range cycles {
		resp.T[ci] = c.T
		for si, t := range p.targets {
			r, ok := c.R[t.ID]
			if !ok {
				continue
			}
			s := &resp.Series[si]
			s.P50[ci], s.Max[ci] = r.P50, r.Max
			lost := r.Lost
			s.Lost[ci] = &lost
		}
	}
	p.mu.Unlock()
	return resp
}

func defaultProbeDataPath() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		dir = "."
	}
	return filepath.Join(dir, "macmon-web", "latency.jsonl")
}
