package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

type event struct {
	name string
	data []byte
}

// Sampler 按需运行 `macmon pipe`：有订阅者时才采样，最后一个订阅者离开 idle 时长后停止，
// 这样没人看页面时不占 CPU 和内存。
type Sampler struct {
	bin      string
	interval time.Duration
	idle     time.Duration

	mu        sync.Mutex
	subs      map[chan event]struct{}
	latest    []byte
	lastErr   []byte
	stop      context.CancelFunc
	idleTimer *time.Timer
}

func NewSampler(bin string, interval, idle time.Duration) *Sampler {
	return &Sampler{
		bin:      bin,
		interval: interval,
		idle:     idle,
		subs:     make(map[chan event]struct{}),
	}
}

// Subscribe 返回事件通道和取消函数。通道只缓冲 1 帧：慢客户端只会丢旧帧，不会拖住其他人。
func (s *Sampler) Subscribe() (<-chan event, func()) {
	ch := make(chan event, 1)

	s.mu.Lock()
	s.subs[ch] = struct{}{}
	if s.idleTimer != nil {
		s.idleTimer.Stop()
		s.idleTimer = nil
	}
	if s.stop == nil {
		// 上次运行留下的数据已过期，不能当作当前值推给新客户端。
		s.latest = nil
		s.lastErr = nil
		ctx, cancel := context.WithCancel(context.Background())
		s.stop = cancel
		go s.loop(ctx)
		slog.Info("sampler started")
	} else if s.latest != nil {
		ch <- event{"metrics", s.latest}
	} else if s.lastErr != nil {
		ch <- event{"status", s.lastErr}
	}
	s.mu.Unlock()

	var once sync.Once
	return ch, func() { once.Do(func() { s.unsubscribe(ch) }) }
}

func (s *Sampler) unsubscribe(ch chan event) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.subs, ch)
	if len(s.subs) > 0 || s.stop == nil {
		return
	}
	var t *time.Timer
	t = time.AfterFunc(s.idle, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		// 已触发的旧定时器可能在等锁期间被新一轮订阅/退订取代，Stop() 拦不住它，只能在这里核对身份。
		if s.idleTimer != t || len(s.subs) > 0 || s.stop == nil {
			return
		}
		s.stop()
		s.stop = nil
		s.idleTimer = nil
		slog.Info("sampler stopped (idle)")
	})
	s.idleTimer = t
}

// Shutdown 结束子进程，供进程退出时调用，避免留下孤儿 macmon。
func (s *Sampler) Shutdown() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.idleTimer != nil {
		s.idleTimer.Stop()
		s.idleTimer = nil
	}
	if s.stop != nil {
		s.stop()
		s.stop = nil
	}
}

// broadcast 在锁内检查 ctx：stop() 也在锁内调用，因此已停止的旧一轮采样不会再写入数据。
func (s *Sampler) broadcast(ctx context.Context, e event) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if ctx.Err() != nil {
		return
	}
	switch e.name {
	case "metrics":
		s.latest = e.data
		s.lastErr = nil
	case "status":
		s.lastErr = e.data
	}
	for ch := range s.subs {
		select {
		case ch <- e:
		default:
			select {
			case <-ch:
			default:
			}
			select {
			case ch <- e:
			default:
			}
		}
	}
}

func (s *Sampler) loop(ctx context.Context) {
	const maxBackoff = 30 * time.Second
	backoff := time.Second
	for {
		started := time.Now()
		err := s.runOnce(ctx)
		if ctx.Err() != nil {
			return
		}
		// 跑过一段时间才挂的，视为偶发故障，退避从头算。
		if time.Since(started) > 10*time.Second {
			backoff = time.Second
		}
		slog.Error("macmon exited", "err", err, "retry_in", backoff)
		msg, mErr := json.Marshal(map[string]string{"state": "error", "message": err.Error()})
		if mErr != nil {
			slog.Error("marshal status", "err", mErr)
		} else {
			s.broadcast(ctx, event{"status", msg})
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, maxBackoff)
	}
}

func (s *Sampler) runOnce(ctx context.Context) error {
	ms := strconv.FormatInt(s.interval.Milliseconds(), 10)
	cmd := exec.CommandContext(ctx, s.bin, "pipe", "--soc-info", "-i", ms)
	cmd.WaitDelay = 2 * time.Second
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("stdout pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start %s: %w", s.bin, err)
	}

	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		if !json.Valid(line) {
			slog.Warn("skip invalid json line from macmon", "len", len(line))
			continue
		}
		s.broadcast(ctx, event{"metrics", bytes.Clone(line)})
	}
	scanErr := sc.Err()
	if scanErr != nil {
		// Scanner 出错后没人再读 stdout，macmon 会阻塞在写满的管道上，Wait 永远等不到它退出。
		if err := cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
			slog.Warn("kill macmon", "err", err)
		}
	}
	waitErr := cmd.Wait()

	if ctx.Err() != nil {
		return ctx.Err()
	}
	detail := strings.TrimSpace(stderr.String())
	err = errors.Join(scanErr, waitErr)
	if err == nil {
		err = errors.New("macmon pipe exited unexpectedly")
	}
	if detail != "" {
		err = fmt.Errorf("%w: %s", err, detail)
	}
	return err
}
