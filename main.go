package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

//go:embed web/index.html web/app.js web/icon.svg web/apple-touch-icon.png web/manifest.json web/vendor web/dist
var webFS embed.FS

func main() {
	addr := flag.String("addr", "127.0.0.1:8000", "listen address")
	interval := flag.Duration("interval", time.Second, "sampling interval")
	idle := flag.Duration("idle", 30*time.Second, "stop macmon after no clients for this long")
	bin := flag.String("macmon", "macmon", "path to macmon binary")
	probeSpec := flag.String("probe", "", "latency targets, comma-separated [tls:][name=]host:port (default mode: direct TCP bypassing proxies; tls: TLS handshake via system routing); empty disables probing")
	probeInterval := flag.Duration("probe-interval", time.Minute, "latency probe interval")
	probeKeep := flag.Duration("probe-keep", 7*24*time.Hour, "how long to keep latency history")
	probeData := flag.String("probe-data", defaultProbeDataPath(), "latency history file (JSON Lines)")
	flag.Parse()

	// 参数写错直接退出：延迟探测是显式开启的功能，静默忽略会让人以为在记录。
	var prober *Prober
	if *probeSpec != "" {
		targets, err := parseProbeTargets(*probeSpec)
		if err == nil {
			prober, err = NewProber(targets, *probeInterval, *probeKeep, *probeData)
		}
		if err != nil {
			slog.Error("probe config", "err", err)
			os.Exit(2)
		}
	}

	// 找不到 macmon 不退出：错误会通过 SSE 推到页面上，装好后无需重启本服务。
	if _, err := exec.LookPath(*bin); err != nil {
		slog.Warn("macmon not found, page will show an error until it is installed", "bin", *bin, "err", err)
	}

	sampler := NewSampler(*bin, *interval, *idle)
	defer sampler.Shutdown()

	static, err := fs.Sub(webFS, "web")
	if err != nil {
		slog.Error("embed fs", "err", err)
		os.Exit(1)
	}

	mux := http.NewServeMux()
	mux.Handle("GET /", http.FileServerFS(static))
	mux.HandleFunc("GET /api/stream", streamHandler(sampler))
	mux.HandleFunc("GET /api/json", snapshotHandler(sampler))
	mux.HandleFunc("GET /api/latency", latencyHandler(prober))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// 等探测协程关掉历史文件再退出，免得最后一行写一半。
	var probeWG sync.WaitGroup
	if prober != nil {
		probeWG.Add(1)
		go func() {
			defer probeWG.Done()
			prober.Run(ctx)
		}()
	}

	srv := &http.Server{
		Addr:              *addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		// SSE 是长连接，Shutdown 不会打断它们；请求 ctx 继承信号 ctx，收到信号时 handler 自行退出。
		BaseContext: func(net.Listener) context.Context { return ctx },
	}

	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		<-ctx.Done()
		slog.Info("shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			slog.Error("http shutdown", "err", err)
		}
	}()
	slog.Info("listening", "url", "http://"+*addr)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("http server", "err", err)
		sampler.Shutdown()
		os.Exit(1)
	}
	<-shutdownDone
	probeWG.Wait()
}

func streamHandler(s *Sampler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming unsupported", http.StatusInternalServerError)
			return
		}
		h := w.Header()
		h.Set("Content-Type", "text/event-stream")
		h.Set("Cache-Control", "no-cache")
		h.Set("Connection", "keep-alive")

		ch, unsubscribe := s.Subscribe()
		defer unsubscribe()

		if _, err := fmt.Fprint(w, "retry: 3000\n\n"); err != nil {
			return
		}
		flusher.Flush()

		heartbeat := time.NewTicker(15 * time.Second)
		defer heartbeat.Stop()
		for {
			select {
			case <-r.Context().Done():
				return
			case <-heartbeat.C:
				if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
					return
				}
			case e := <-ch:
				if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", e.name, e.data); err != nil {
					return
				}
			}
			flusher.Flush()
		}
	}
}

// snapshotHandler 临时订阅拿一帧，便于 curl 调试；采样进程会按 idle 规则自行停止。
func snapshotHandler(s *Sampler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ch, unsubscribe := s.Subscribe()
		defer unsubscribe()

		timeout := time.NewTimer(5 * time.Second)
		defer timeout.Stop()
		for {
			select {
			case <-r.Context().Done():
				return
			case <-timeout.C:
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusServiceUnavailable)
				if _, err := w.Write([]byte(`{"error":"timeout waiting for macmon"}`)); err != nil {
					slog.Warn("write snapshot", "err", err)
				}
				return
			case e := <-ch:
				w.Header().Set("Content-Type", "application/json")
				if e.name != "metrics" {
					w.WriteHeader(http.StatusBadGateway)
				}
				if _, err := w.Write(e.data); err != nil {
					slog.Warn("write snapshot", "err", err)
				}
				return
			}
		}
	}
}

// latencyHandler 未开启探测时也返回 200 和 enabled:false，前端据此决定是否显示延迟卡片。
func latencyHandler(p *Prober) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// 未开启时只输出 enabled，不带 t/series 等空字段。
		var resp any = struct {
			Enabled bool `json:"enabled"`
		}{}
		if p != nil {
			window := 24 * time.Hour
			if v := r.URL.Query().Get("range"); v != "" {
				d, err := time.ParseDuration(v)
				if err != nil || d <= 0 {
					http.Error(w, "invalid range, want a Go duration like 1h or 168h", http.StatusBadRequest)
					return
				}
				window = d
			}
			resp = p.Snapshot(window)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		if err := json.NewEncoder(w).Encode(resp); err != nil {
			slog.Warn("write latency", "err", err)
		}
	}
}
