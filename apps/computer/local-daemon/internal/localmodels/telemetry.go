package localmodels

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/process"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/redact"
	wire "github.com/simplexai-labs/linger/contracts-go/runnergateway"
)

// System telemetry frame statuses and unavailable reason codes.
const (
	TelemetryStatusOK          = "ok"
	TelemetryStatusUnsupported = "unsupported"
	TelemetryStatusUnavailable = "unavailable"

	CodeTelemetryToolNotInstalled    = "TOOL_NOT_INSTALLED"
	CodeTelemetryLiveTickUnsupported = "LIVE_TICK_UNSUPPORTED"
	CodeTelemetryCollectorFailed     = "COLLECTOR_FAILED"

	defaultTelemetryInterval      = time.Second
	minTelemetryInterval          = 250 * time.Millisecond
	maxTelemetryInterval          = 10 * time.Second
	minTelemetryLeaseTTL          = time.Second
	maxTelemetryLeaseTTL          = 120 * time.Second
	defaultTelemetryShutdownGrace = time.Second
	defaultTelemetryRetryBackoff  = 2 * time.Second
	maxTelemetryRetryBackoff      = 30 * time.Second
	maxTelemetryLineBytes         = 2 << 20
	maxTelemetryStderrBytes       = 4096
	maxTelemetryZeroTickRetries   = 3
)

// TelemetryUpdate is one snapshot or status update emitted by TelemetryCollector.
type TelemetryUpdate struct {
	Status   string
	Snapshot *wire.SystemTelemetrySnapshot
	Reason   *wire.SystemTelemetryUnavailableReason
}

// TelemetryOptions configures an on-demand TelemetryCollector.
type TelemetryOptions struct {
	// Tool is nil when the installer configured no localmodels tool.
	Tool *Tool
	// Environment is the base process environment passed to localmodels.
	Environment map[string]string
	// CommandFactory builds the collector command when set (used by tests).
	CommandFactory func(interval time.Duration) *exec.Cmd
	// Publish receives each snapshot or status update in emission order.
	Publish func(TelemetryUpdate)
	// ShutdownGrace bounds SIGTERM wait before SIGKILL (defaults to 1s).
	ShutdownGrace time.Duration
	// RetryBackoff is the initial delay before restarting after an unexpected exit.
	RetryBackoff time.Duration
}

// TelemetryCollector supervises `localmodels stack view --json --live-tick --stream`
// strictly while an active lease exists. When idle, no goroutine or subprocess runs.
type TelemetryCollector struct {
	tool           *Tool
	environment    map[string]string
	commandFactory func(interval time.Duration) *exec.Cmd
	publish        func(TelemetryUpdate)
	shutdownGrace  time.Duration
	retryBackoff   time.Duration

	mu            sync.Mutex
	closed        bool
	active        bool
	leaseTimer    *time.Timer
	runCancel     context.CancelFunc
	runDone       chan struct{}
	unsupported   *wire.SystemTelemetryUnavailableReason
	activeWorkers sync.WaitGroup
}

// NewTelemetryCollector creates a lazy telemetry collector that starts no
// background work until Subscribe is called.
func NewTelemetryCollector(options TelemetryOptions) *TelemetryCollector {
	grace := options.ShutdownGrace
	if grace <= 0 {
		grace = defaultTelemetryShutdownGrace
	}
	backoff := options.RetryBackoff
	if backoff <= 0 {
		backoff = defaultTelemetryRetryBackoff
	}
	env := make(map[string]string, len(options.Environment))
	for key, value := range options.Environment {
		env[key] = value
	}
	publish := options.Publish
	if publish == nil {
		publish = func(TelemetryUpdate) {}
	}
	return &TelemetryCollector{
		tool:           options.Tool,
		environment:    env,
		commandFactory: options.CommandFactory,
		publish:        publish,
		shutdownGrace:  grace,
		retryBackoff:   backoff,
	}
}

// Subscribe starts or renews the on-demand telemetry collection lease.
func (c *TelemetryCollector) Subscribe(leaseTTL time.Duration, interval time.Duration) {
	leaseTTL = clampDuration(leaseTTL, minTelemetryLeaseTTL, maxTelemetryLeaseTTL)
	if interval <= 0 {
		interval = defaultTelemetryInterval
	}
	interval = clampDuration(interval, minTelemetryInterval, maxTelemetryInterval)

	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	if c.tool == nil && c.commandFactory == nil {
		c.mu.Unlock()
		c.publish(TelemetryUpdate{
			Status: TelemetryStatusUnsupported,
			Reason: &wire.SystemTelemetryUnavailableReason{
				Code:   CodeTelemetryToolNotInstalled,
				Detail: "localmodels tool is not configured on this Computer",
			},
		})
		return
	}
	if c.unsupported != nil {
		reason := *c.unsupported
		c.mu.Unlock()
		c.publish(TelemetryUpdate{Status: TelemetryStatusUnsupported, Reason: &reason})
		return
	}

	if c.leaseTimer != nil {
		c.leaseTimer.Stop()
	}
	c.leaseTimer = time.AfterFunc(leaseTTL, c.expireLease)

	if c.active {
		c.mu.Unlock()
		return
	}
	prevDone := c.runDone
	runCtx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	c.active = true
	c.runCancel = cancel
	c.runDone = done
	c.activeWorkers.Add(1)
	c.mu.Unlock()

	go c.supervise(runCtx, interval, prevDone, done)
}

// Unsubscribe cancels the active lease immediately and terminates any running
// collector subprocess without blocking the caller.
func (c *TelemetryCollector) Unsubscribe() {
	c.mu.Lock()
	c.stopLocked()
	c.mu.Unlock()
}

// StopAndWait cancels any active lease and waits until the collector goroutine
// and its child process group have exited completely.
func (c *TelemetryCollector) StopAndWait() {
	c.mu.Lock()
	c.stopLocked()
	done := c.runDone
	c.mu.Unlock()
	if done != nil {
		<-done
	}
}

// Close permanently stops the collector and waits for full subprocess cleanup.
func (c *TelemetryCollector) Close() {
	c.mu.Lock()
	c.closed = true
	c.stopLocked()
	c.mu.Unlock()
	c.activeWorkers.Wait()
}

func (c *TelemetryCollector) expireLease() {
	c.mu.Lock()
	c.stopLocked()
	c.mu.Unlock()
}

func (c *TelemetryCollector) stopLocked() {
	if c.leaseTimer != nil {
		c.leaseTimer.Stop()
		c.leaseTimer = nil
	}
	if c.runCancel != nil {
		c.runCancel()
		c.runCancel = nil
	}
	c.active = false
}

func (c *TelemetryCollector) supervise(ctx context.Context, interval time.Duration, prevDone <-chan struct{}, done chan struct{}) {
	defer close(done)
	defer c.activeWorkers.Done()
	defer func() {
		c.mu.Lock()
		if c.runDone == done {
			c.active = false
			if c.leaseTimer != nil {
				c.leaseTimer.Stop()
				c.leaseTimer = nil
			}
			c.runCancel = nil
		}
		c.mu.Unlock()
	}()

	if prevDone != nil {
		select {
		case <-prevDone:
		case <-ctx.Done():
			return
		}
	}

	backoff := c.retryBackoff
	zeroTickFailures := 0
	for ctx.Err() == nil {
		outcome := c.runStreamOnce(ctx, interval)
		if ctx.Err() != nil {
			return
		}
		if outcome.unsupported != nil {
			c.mu.Lock()
			c.unsupported = outcome.unsupported
			c.mu.Unlock()
			c.publish(TelemetryUpdate{
				Status: TelemetryStatusUnsupported,
				Reason: outcome.unsupported,
			})
			return
		}
		if outcome.sawTick {
			zeroTickFailures = 0
			backoff = c.retryBackoff
		} else {
			zeroTickFailures++
		}
		c.publish(TelemetryUpdate{
			Status: TelemetryStatusUnavailable,
			Reason: &wire.SystemTelemetryUnavailableReason{
				Code:   CodeTelemetryCollectorFailed,
				Detail: outcome.detail,
			},
		})
		if zeroTickFailures >= maxTelemetryZeroTickRetries {
			return
		}
		timer := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		backoff = min(backoff*2, maxTelemetryRetryBackoff)
	}
}

type streamOutcome struct {
	sawTick     bool
	unsupported *wire.SystemTelemetryUnavailableReason
	detail      string
}

func (c *TelemetryCollector) buildCommand(interval time.Duration) *exec.Cmd {
	if c.commandFactory != nil {
		return c.commandFactory(interval)
	}
	args := []string{
		"-u", "-P", "-s", "-m", "localmodels",
		"stack", "view", "--json", "--live-tick", "--stream",
		"--interval", strconv.FormatFloat(interval.Seconds(), 'f', 3, 64),
	}
	return c.tool.commandArgs(c.environment, args)
}

func (c *TelemetryCollector) runStreamOnce(ctx context.Context, interval time.Duration) streamOutcome {
	cmd := c.buildCommand(interval)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return streamOutcome{detail: "unable to open telemetry collector stdout"}
	}
	stderr := &boundedBuffer{limit: maxTelemetryStderrBytes}
	cmd.Stderr = stderr

	if err := process.Start(cmd); err != nil {
		return streamOutcome{detail: redact.Text(truncateString(err.Error(), 300))}
	}
	defer process.Release(cmd)

	exited := make(chan struct{})
	stopDone := make(chan struct{})
	go func() {
		defer close(stopDone)
		select {
		case <-exited:
			return
		case <-ctx.Done():
		}
		_ = process.Signal(cmd, syscall.SIGTERM)
		grace := time.NewTimer(c.shutdownGrace)
		defer grace.Stop()
		select {
		case <-exited:
			return
		case <-grace.C:
			_ = process.Signal(cmd, syscall.SIGKILL)
		}
	}()

	reader := bufio.NewReaderSize(stdout, 64*1024)
	sawTick := false
	for {
		line, readErr := readBoundedLine(reader, maxTelemetryLineBytes)
		if len(line) > 0 && ctx.Err() == nil {
			snapshot, parseErr := ParseSystemTelemetrySnapshot(line)
			if parseErr != nil {
				slog.Warn("system_telemetry.parse_failed", "error", parseErr)
			} else {
				sawTick = true
				c.publish(TelemetryUpdate{
					Status:   TelemetryStatusOK,
					Snapshot: snapshot,
				})
			}
		}
		if readErr != nil {
			if !errors.Is(readErr, io.EOF) && ctx.Err() == nil {
				slog.Warn("system_telemetry.read_failed", "error", readErr)
			}
			break
		}
	}

	waitErr := cmd.Wait()
	close(exited)
	<-stopDone
	// Ensure no descendant process outlives the collector.
	_ = process.Signal(cmd, syscall.SIGKILL)
	_ = process.WaitEmpty(cmd, 2*time.Second)

	if ctx.Err() != nil {
		return streamOutcome{sawTick: sawTick}
	}

	var exitErr *exec.ExitError
	exitCode := 0
	if errors.As(waitErr, &exitErr) {
		exitCode = exitErr.ExitCode()
	}
	detail := strings.TrimSpace(redact.Text(stderr.String()))
	// Python argparse exits with status 2 when an older localmodels kit rejects
	// --live-tick or --stream.
	if !sawTick && exitCode == 2 {
		if detail == "" {
			detail = "installed localmodels tool does not support stack view --live-tick"
		}
		return streamOutcome{
			unsupported: &wire.SystemTelemetryUnavailableReason{
				Code:   CodeTelemetryLiveTickUnsupported,
				Detail: truncateString(detail, 500),
			},
		}
	}
	if detail == "" {
		if waitErr != nil {
			detail = fmt.Sprintf("telemetry collector exited with status %d", exitCode)
		} else {
			detail = "telemetry collector closed stdout unexpectedly"
		}
	}
	return streamOutcome{sawTick: sawTick, detail: truncateString(detail, 500)}
}

type boundedBuffer struct {
	limit int
	buf   bytes.Buffer
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	if remaining := b.limit - b.buf.Len(); remaining > 0 {
		if len(p) > remaining {
			_, _ = b.buf.Write(p[:remaining])
		} else {
			_, _ = b.buf.Write(p)
		}
	}
	return len(p), nil
}

func (b *boundedBuffer) String() string { return b.buf.String() }

func readBoundedLine(reader *bufio.Reader, limit int) ([]byte, error) {
	var out []byte
	for {
		chunk, isPrefix, err := reader.ReadLine()
		if len(chunk) > 0 {
			if len(out)+len(chunk) > limit {
				// Discard the remainder of an oversized line cleanly.
				for isPrefix && err == nil {
					_, isPrefix, err = reader.ReadLine()
				}
				return nil, fmt.Errorf("telemetry line exceeded %d bytes", limit)
			}
			out = append(out, chunk...)
		}
		if !isPrefix || err != nil {
			return bytes.TrimSpace(out), err
		}
	}
}

func clampDuration(value, low, high time.Duration) time.Duration {
	if value < low {
		return low
	}
	if value > high {
		return high
	}
	return value
}

// ParseSystemTelemetrySnapshot parses raw JSON from `localmodels stack view --json --live-tick`
// into an allowlisted wire.SystemTelemetrySnapshot, stripping unknown fields (including any
// prompt/completion text) and normalizing optional bounds so wire validation never fails.
func ParseSystemTelemetrySnapshot(raw []byte) (*wire.SystemTelemetrySnapshot, error) {
	var in rawStackView
	if err := json.Unmarshal(raw, &in); err != nil {
		return nil, err
	}
	schema := strings.TrimSpace(in.Schema)
	generatedAt := strings.TrimSpace(in.GeneratedAt)
	source := normalizeSource(in.Source)
	if schema == "" || generatedAt == "" || source == "" {
		return nil, errors.New("missing required stack-view fields")
	}

	out := &wire.SystemTelemetrySnapshot{
		Schema:               truncateString(schema, 64),
		SchemaVersion:        truncateString(strings.TrimSpace(in.SchemaVersion), 32),
		GeneratedAt:          truncateString(generatedAt, 64),
		Source:               source,
		Lang:                 truncateString(strings.TrimSpace(in.Lang), 16),
		PlanID:               truncateOptionalString(in.PlanID, 128),
		EffectiveDecodeBwGbS: mapFigure(in.EffectiveDecodeBwGbS),
		MemoryBwCeilingGbS:   mapFigure(in.MemoryBwCeilingGbS),
		Bottleneck:           normalizeBottleneck(in.Bottleneck),
		P50TtftMs:            mapFigure(in.P50TtftMs),
		PrefixHitPct:         mapFigure(in.PrefixHitPct),
		RequestsDeferred:     mapFigure(in.RequestsDeferred),
		KvCacheUsageRatio:    mapFigure(in.KvCacheUsageRatio),
		InFlight:             nonNegUint(in.InFlight),
		ClientLanes:          marshalUintMap(in.ClientLanes),
	}
	if in.Host != nil {
		out.Host = &wire.SystemTelemetryHost{
			Hostname: truncateString(in.Host.Hostname, 256),
			System:   truncateString(in.Host.System, 200),
			Tier:     truncateString(in.Host.Tier, 120),
		}
	}
	if in.Gateway != nil {
		out.Gateway = &wire.SystemTelemetryGateway{
			Kind:        truncateString(in.Gateway.Kind, 64),
			Addr:        truncateString(in.Gateway.Addr, 256),
			Route:       truncateString(in.Gateway.Route, 200),
			InFlight:    nonNegUint(in.Gateway.InFlight),
			ClientLanes: marshalUintMap(in.Gateway.ClientLanes),
			P50TtftMs:   mapFigure(in.Gateway.P50TtftMs),
		}
	}
	if len(in.Clients) > 0 {
		limit := min(len(in.Clients), 64)
		out.Clients = make([]wire.SystemTelemetryClient, 0, limit)
		for _, client := range in.Clients[:limit] {
			if strings.TrimSpace(client.ID) == "" {
				continue
			}
			out.Clients = append(out.Clients, wire.SystemTelemetryClient{
				ID:    truncateString(client.ID, 120),
				Name:  truncateString(client.Name, 200),
				Model: truncateString(client.Model, 200),
			})
		}
	}
	if len(in.Components) > 0 {
		limit := min(len(in.Components), 64)
		out.Components = make([]wire.SystemTelemetryComponent, 0, limit)
		for _, comp := range in.Components[:limit] {
			if strings.TrimSpace(comp.ID) == "" {
				continue
			}
			out.Components = append(out.Components, mapComponent(comp))
		}
	}
	if len(in.Gpus) > 0 {
		limit := min(len(in.Gpus), 64)
		out.Gpus = make([]wire.SystemTelemetryGpu, 0, limit)
		for _, gpu := range in.Gpus[:limit] {
			out.Gpus = append(out.Gpus, mapGpu(gpu))
		}
	}
	if len(in.GpuLoad) > 0 {
		limit := min(len(in.GpuLoad), 64)
		out.GpuLoad = make([]wire.SystemTelemetryGpuLoad, 0, limit)
		for _, row := range in.GpuLoad[:limit] {
			out.GpuLoad = append(out.GpuLoad, wire.SystemTelemetryGpuLoad{
				Index:          clampNonNegInt64(row.Index),
				UtilPct:        clampFloat(row.UtilPct, 0, 100),
				MemCtrlUtilPct: clampFloat(row.MemCtrlUtilPct, 0, 100),
				VramTotalBytes: nonNegUint(row.VramTotalBytes),
				VramUsedBytes:  nonNegUint(row.VramUsedBytes),
				VramFreeBytes:  nonNegUint(row.VramFreeBytes),
				PowerW:         nonNegFloat(row.PowerW),
				PowerLimitW:    nonNegFloat(row.PowerLimitW),
				TempC:          finiteFloat(row.TempC),
				Basis:          normalizeBasis(row.Basis),
				Source:         truncateString(row.Source, 64),
			})
		}
	}
	if in.Ram != nil {
		out.Ram = &wire.SystemTelemetryMemory{
			TotalBytes:     clampNonNegInt64(in.Ram.TotalBytes),
			AvailableBytes: clampNonNegInt64(in.Ram.AvailableBytes),
			Segments:       mapSegments(in.Ram.Segments),
		}
	}
	if in.WhatIf != nil {
		out.WhatIf = mapWhatIf(in.WhatIf)
	}
	if len(in.Events) > 0 {
		limit := min(len(in.Events), 100)
		out.Events = make([]wire.SystemTelemetryEvent, 0, limit)
		for _, ev := range in.Events[:limit] {
			out.Events = append(out.Events, wire.SystemTelemetryEvent{
				ID:        truncateString(ev.ID, 128),
				At:        truncateString(ev.At, 64),
				Kind:      truncateString(ev.Kind, 32),
				Component: truncateOptionalString(ev.Component, 64),
				Ok:        ev.Ok,
				LatencyMs: nonNegFloat(ev.LatencyMs),
				GatewayMs: nonNegFloat(ev.GatewayMs),
				Tier:      truncateOptionalString(ev.Tier, 32),
				TokensIn:  nonNegUint(ev.TokensIn),
				TokensOut: nonNegUint(ev.TokensOut),
				TtftMs:    nonNegFloat(ev.TtftMs),
			})
		}
	}
	if len(in.Measured) > 0 {
		limit := min(len(in.Measured), 64)
		out.Measured = make([]wire.SystemTelemetryMeasuredRow, 0, limit)
		for _, row := range in.Measured[:limit] {
			mem := row.Memory
			if mem != "vram" && mem != "ram" {
				continue
			}
			out.Measured = append(out.Measured, wire.SystemTelemetryMeasuredRow{
				ID:            truncateString(row.ID, 64),
				Memory:        mem,
				Gpu:           nonNegUint(row.Gpu),
				PlannedBytes:  clampNonNegInt64(row.PlannedBytes),
				MeasuredBytes: nonNegUint(row.MeasuredBytes),
				Over:          row.Over,
			})
		}
	}
	if len(in.Notes) > 0 {
		limit := min(len(in.Notes), 64)
		out.Notes = make([]string, 0, limit)
		for _, note := range in.Notes[:limit] {
			out.Notes = append(out.Notes, truncateString(note, 500))
		}
	}
	if len(in.NextSteps) > 0 {
		limit := min(len(in.NextSteps), 32)
		out.NextSteps = make([]wire.SystemTelemetryStep, 0, limit)
		for _, step := range in.NextSteps[:limit] {
			out.NextSteps = append(out.NextSteps, wire.SystemTelemetryStep{
				Command: truncateString(step.Command, 300),
				Why:     truncateString(step.Why, 500),
			})
		}
	}
	if in.Apply != nil {
		out.Apply = mapApply(in.Apply)
	}
	if in.Sensors != nil {
		out.Sensors = mapHostSensors(in.Sensors)
	}
	if len(in.Waterfall) > 0 {
		limit := min(len(in.Waterfall), 64)
		out.Waterfall = make([]wire.SystemTelemetryWaterfallEntry, 0, limit)
		for _, entry := range in.Waterfall[:limit] {
			out.Waterfall = append(out.Waterfall, wire.SystemTelemetryWaterfallEntry{
				RequestID:        truncateString(entry.RequestID, 128),
				At:               truncateString(entry.At, 64),
				ClientID:         truncateString(entry.ClientID, 120),
				ModelID:          truncateString(entry.ModelID, 200),
				Status:           normalizeWaterfallStatus(entry.Status),
				GatewayMs:        nonNegFloat(entry.GatewayMs),
				TtftMs:           nonNegFloat(entry.TtftMs),
				DecodeMs:         nonNegFloat(entry.DecodeMs),
				PromptTokens:     nonNegUint(entry.PromptTokens),
				CompletionTokens: nonNegUint(entry.CompletionTokens),
				CachedPrefixPct:  clampFloat(entry.CachedPrefixPct, 0, 100),
				DecodeTokS:       nonNegFloat(entry.DecodeTokS),
				Basis:            normalizeBasis(entry.Basis),
			})
		}
	}
	return out, nil
}

// Raw JSON input types matching localmodels.stack-view/v1 (v1.1).
type rawStackView struct {
	Schema               string              `json:"schema"`
	SchemaVersion        string              `json:"schema_version"`
	GeneratedAt          string              `json:"generated_at"`
	Source               string              `json:"source"`
	Lang                 string              `json:"lang"`
	PlanID               *string             `json:"plan_id"`
	Host                 *rawHost            `json:"host"`
	Gateway              *rawGateway         `json:"gateway"`
	Clients              []rawClient         `json:"clients"`
	Components           []rawComponent      `json:"components"`
	Gpus                 []rawGpu            `json:"gpus"`
	GpuLoad              []rawGpuLoad        `json:"gpu_load"`
	Ram                  *rawMemory          `json:"ram"`
	WhatIf               *rawWhatIf          `json:"what_if"`
	Events               []rawEvent          `json:"events"`
	Measured             []rawMeasuredRow    `json:"measured"`
	Notes                []string            `json:"notes"`
	NextSteps            []rawStep           `json:"next_steps"`
	Apply                *rawApply           `json:"apply"`
	Sensors              *rawHostSensors     `json:"sensors"`
	EffectiveDecodeBwGbS *rawFigure          `json:"effective_decode_bw_gb_s"`
	MemoryBwCeilingGbS   *rawFigure          `json:"memory_bw_ceiling_gb_s"`
	Bottleneck           string              `json:"bottleneck"`
	Waterfall            []rawWaterfallEntry `json:"waterfall"`
	P50TtftMs            *rawFigure          `json:"p50_ttft_ms"`
	PrefixHitPct         *rawFigure          `json:"prefix_hit_pct"`
	RequestsDeferred     *rawFigure          `json:"requests_deferred"`
	KvCacheUsageRatio    *rawFigure          `json:"kv_cache_usage_ratio"`
	InFlight             *int64              `json:"in_flight"`
	ClientLanes          map[string]int64    `json:"client_lanes"`
}

type rawFigure struct {
	Value *float64 `json:"value"`
	Basis string   `json:"basis"`
	Note  string   `json:"note"`
}

type rawSegment struct {
	Kind      string  `json:"kind"`
	Label     string  `json:"label"`
	Bytes     int64   `json:"bytes"`
	Basis     string  `json:"basis"`
	Component *string `json:"component"`
	Note      string  `json:"note"`
}

type rawFit struct {
	ID         string   `json:"id"`
	Quant      string   `json:"quant"`
	DecodeTokS *float64 `json:"decode_tok_s"`
}

type rawGpu struct {
	Index        int64        `json:"index"`
	Name         string       `json:"name"`
	TotalBytes   int64        `json:"total_bytes"`
	UsedBytes    int64        `json:"used_bytes"`
	BandwidthGbS *float64     `json:"bandwidth_gb_s"`
	Holders      []string     `json:"holders"`
	Segments     []rawSegment `json:"segments"`
	Fits         []rawFit     `json:"fits"`
}

type rawGpuLoad struct {
	Index          int64    `json:"index"`
	UtilPct        *float64 `json:"util_pct"`
	MemCtrlUtilPct *float64 `json:"mem_ctrl_util_pct"`
	VramTotalBytes *int64   `json:"vram_total_bytes"`
	VramUsedBytes  *int64   `json:"vram_used_bytes"`
	VramFreeBytes  *int64   `json:"vram_free_bytes"`
	PowerW         *float64 `json:"power_w"`
	PowerLimitW    *float64 `json:"power_limit_w"`
	TempC          *float64 `json:"temp_c"`
	Basis          string   `json:"basis"`
	Source         string   `json:"source"`
}

type rawMemory struct {
	TotalBytes     int64        `json:"total_bytes"`
	AvailableBytes int64        `json:"available_bytes"`
	Segments       []rawSegment `json:"segments"`
}

type rawCounters struct {
	PromptTokens           *float64 `json:"prompt_tokens"`
	PromptSeconds          *float64 `json:"prompt_seconds"`
	PredictedTokens        *float64 `json:"predicted_tokens"`
	PredictedSeconds       *float64 `json:"predicted_seconds"`
	Processing             *float64 `json:"processing"`
	RequestsDeferred       *float64 `json:"requests_deferred"`
	KvCacheUsageRatio      *float64 `json:"kv_cache_usage_ratio"`
	PromptTokensSeconds    *float64 `json:"prompt_tokens_seconds"`
	PredictedTokensSeconds *float64 `json:"predicted_tokens_seconds"`
}

type rawSlot struct {
	ID                 int64    `json:"id"`
	NCtx               *int64   `json:"n_ctx"`
	Busy               bool     `json:"busy"`
	Phase              string   `json:"phase"`
	PromptTokens       *int64   `json:"prompt_tokens"`
	PromptDone         *int64   `json:"prompt_done"`
	Cached             *int64   `json:"cached"`
	Decoded            *int64   `json:"decoded"`
	NPrompt            *int64   `json:"n_prompt"`
	CachedPrefixTokens *int64   `json:"cached_prefix_tokens"`
	NDecoded           *int64   `json:"n_decoded"`
	TokS               *float64 `json:"tok_s"`
	TtftMs             *float64 `json:"ttft_ms"`
}

type rawPerf struct {
	PrefillTokS *rawFigure       `json:"prefill_tok_s"`
	DecodeTokS  *rawFigure       `json:"decode_tok_s"`
	DecodeBound *rawFigure       `json:"decode_bound"`
	LatencyMs   *rawFigure       `json:"latency_ms"`
	Calls       *int64           `json:"calls"`
	Failed      *int64           `json:"failed"`
	Tiers       map[string]int64 `json:"tiers"`
	Counters    *rawCounters     `json:"counters"`
}

type rawComponent struct {
	ID        string    `json:"id"`
	Role      string    `json:"role"`
	Title     string    `json:"title"`
	Model     string    `json:"model"`
	Quant     string    `json:"quant"`
	Device    string    `json:"device"`
	Gpu       *int64    `json:"gpu"`
	Endpoint  string    `json:"endpoint"`
	State     string    `json:"state"`
	Health    string    `json:"health"`
	Window    *int64    `json:"window"`
	Slots     *int64    `json:"slots"`
	KvTypes   *string   `json:"kv_types"`
	VramBytes *int64    `json:"vram_bytes"`
	RamBytes  *int64    `json:"ram_bytes"`
	Perf      *rawPerf  `json:"perf"`
	Explain   string    `json:"explain"`
	LiveSlots []rawSlot `json:"live_slots"`
}

type rawClient struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Model string `json:"model"`
}

type rawGateway struct {
	Kind        string           `json:"kind"`
	Addr        string           `json:"addr"`
	Route       string           `json:"route"`
	InFlight    *int64           `json:"in_flight"`
	ClientLanes map[string]int64 `json:"client_lanes"`
	P50TtftMs   *rawFigure       `json:"p50_ttft_ms"`
}

type rawWhatIf struct {
	Gpu                   int64              `json:"gpu"`
	Window                int64              `json:"window"`
	Slots                 int64              `json:"slots"`
	KvBytesPerToken       float64            `json:"kv_bytes_per_token"`
	ComputeBytesPerToken  float64            `json:"compute_bytes_per_token"`
	FixedBytes            int64              `json:"fixed_bytes"`
	RoomBytes             int64              `json:"room_bytes"`
	ActiveWeightBytes     *int64             `json:"active_weight_bytes"`
	WeightsBytes          *int64             `json:"weights_bytes"`
	MemoryBwCeilingGbS    *float64           `json:"memory_bw_ceiling_gb_s"`
	PcieBandwidthGbS      *float64           `json:"pcie_bandwidth_gb_s"`
	KvDtypeFactors        map[string]float64 `json:"kv_dtype_factors"`
	PoolKind              string             `json:"pool_kind"`
	HostRamAvailableBytes *int64             `json:"host_ram_available_bytes"`
}

type rawHost struct {
	Hostname string `json:"hostname"`
	System   string `json:"system"`
	Tier     string `json:"tier"`
}

type rawCoreUsage struct {
	Core    int64   `json:"core"`
	UtilPct float64 `json:"util_pct"`
}

type rawCpuSensors struct {
	OverallPct   *rawFigure     `json:"overall_pct"`
	PerCore      []rawCoreUsage `json:"per_core"`
	LogicalCores *int64         `json:"logical_cores"`
}

type rawDiskSensors struct {
	ReadMbS  *rawFigure `json:"read_mb_s"`
	WriteMbS *rawFigure `json:"write_mb_s"`
}

type rawMemoryPressure struct {
	Level          string   `json:"level"`
	Basis          string   `json:"basis"`
	AvailableRatio *float64 `json:"available_ratio"`
	PsiSomeAvg10   *float64 `json:"psi_some_avg10"`
	SwapUsedBytes  *int64   `json:"swap_used_bytes"`
}

type rawWatchdogHealth struct {
	Status string `json:"status"`
	Basis  string `json:"basis"`
	Detail string `json:"detail"`
}

type rawHostSensors struct {
	Cpu            *rawCpuSensors     `json:"cpu"`
	Disk           *rawDiskSensors    `json:"disk"`
	MemoryPressure *rawMemoryPressure `json:"memory_pressure"`
	Watchdog       *rawWatchdogHealth `json:"watchdog"`
	Collector      string             `json:"collector"`
}

type rawWaterfallEntry struct {
	RequestID        string   `json:"request_id"`
	At               string   `json:"at"`
	ClientID         string   `json:"client_id"`
	ModelID          string   `json:"model_id"`
	Status           string   `json:"status"`
	GatewayMs        *float64 `json:"gateway_ms"`
	TtftMs           *float64 `json:"ttft_ms"`
	DecodeMs         *float64 `json:"decode_ms"`
	PromptTokens     *int64   `json:"prompt_tokens"`
	CompletionTokens *int64   `json:"completion_tokens"`
	CachedPrefixPct  *float64 `json:"cached_prefix_pct"`
	DecodeTokS       *float64 `json:"decode_tok_s"`
	Basis            string   `json:"basis"`
}

type rawEvent struct {
	ID        string   `json:"id"`
	At        string   `json:"at"`
	Kind      string   `json:"kind"`
	Component *string  `json:"component"`
	Ok        bool     `json:"ok"`
	LatencyMs *float64 `json:"latency_ms"`
	GatewayMs *float64 `json:"gateway_ms"`
	Tier      *string  `json:"tier"`
	TokensIn  *int64   `json:"tokens_in"`
	TokensOut *int64   `json:"tokens_out"`
	TtftMs    *float64 `json:"ttft_ms"`
}

type rawMeasuredRow struct {
	ID            string `json:"id"`
	Memory        string `json:"memory"`
	Gpu           *int64 `json:"gpu"`
	PlannedBytes  int64  `json:"planned_bytes"`
	MeasuredBytes *int64 `json:"measured_bytes"`
	Over          bool   `json:"over"`
}

type rawApplyRow struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	Detail string `json:"detail"`
	State  string `json:"state"`
	Step   string `json:"step"`
	Phase  string `json:"phase"`
	Done   *int64 `json:"done"`
	Total  *int64 `json:"total"`
}

type rawApply struct {
	PlanID    string        `json:"plan_id"`
	StartedAt string        `json:"started_at"`
	UpdatedAt string        `json:"updated_at"`
	Rollback  bool          `json:"rollback"`
	Rows      []rawApplyRow `json:"rows"`
}

type rawStep struct {
	Command string `json:"command"`
	Why     string `json:"why"`
}

func mapFigure(in *rawFigure) *wire.SystemTelemetryFigure {
	if in == nil {
		return nil
	}
	return &wire.SystemTelemetryFigure{
		Value: finiteFloat(in.Value),
		Basis: normalizeBasis(in.Basis),
		Note:  truncateString(in.Note, 500),
	}
}

func mapFigureValue(in *rawFigure) wire.SystemTelemetryFigure {
	if in == nil {
		return wire.SystemTelemetryFigure{Basis: "none"}
	}
	return *mapFigure(in)
}

func mapSegments(in []rawSegment) []wire.SystemTelemetrySegment {
	if len(in) == 0 {
		return nil
	}
	limit := min(len(in), 128)
	out := make([]wire.SystemTelemetrySegment, 0, limit)
	for _, seg := range in[:limit] {
		kind := strings.TrimSpace(seg.Kind)
		if kind == "" {
			continue
		}
		out = append(out, wire.SystemTelemetrySegment{
			Kind:      truncateString(kind, 64),
			Label:     truncateString(seg.Label, 200),
			Bytes:     clampNonNegInt64(seg.Bytes),
			Basis:     normalizeBasis(seg.Basis),
			Component: truncateOptionalString(seg.Component, 64),
			Note:      truncateString(seg.Note, 500),
		})
	}
	return out
}

func mapGpu(in rawGpu) wire.SystemTelemetryGpu {
	out := wire.SystemTelemetryGpu{
		Index:        clampNonNegInt64(in.Index),
		Name:         truncateString(in.Name, 200),
		TotalBytes:   clampNonNegInt64(in.TotalBytes),
		UsedBytes:    clampNonNegInt64(in.UsedBytes),
		BandwidthGbS: nonNegFloat(in.BandwidthGbS),
		Segments:     mapSegments(in.Segments),
	}
	if len(in.Holders) > 0 {
		limit := min(len(in.Holders), 128)
		out.Holders = make([]string, 0, limit)
		for _, holder := range in.Holders[:limit] {
			out.Holders = append(out.Holders, truncateString(holder, 200))
		}
	}
	if len(in.Fits) > 0 {
		limit := min(len(in.Fits), 128)
		out.Fits = make([]wire.SystemTelemetryFit, 0, limit)
		for _, fit := range in.Fits[:limit] {
			if strings.TrimSpace(fit.ID) == "" {
				continue
			}
			out.Fits = append(out.Fits, wire.SystemTelemetryFit{
				ID:         truncateString(fit.ID, 160),
				Quant:      truncateString(fit.Quant, 64),
				DecodeTokS: nonNegFloat(fit.DecodeTokS),
			})
		}
	}
	return out
}

func mapComponent(in rawComponent) wire.SystemTelemetryComponent {
	out := wire.SystemTelemetryComponent{
		ID:        truncateString(in.ID, 64),
		Role:      truncateString(in.Role, 64),
		Title:     truncateString(in.Title, 200),
		Model:     truncateString(in.Model, 200),
		Quant:     truncateString(in.Quant, 64),
		Device:    truncateString(in.Device, 120),
		Gpu:       nonNegUint(in.Gpu),
		Endpoint:  truncateString(in.Endpoint, 512),
		State:     truncateString(in.State, 32),
		Health:    truncateString(in.Health, 64),
		Window:    nonNegUint(in.Window),
		Slots:     nonNegUint(in.Slots),
		KvTypes:   truncateOptionalString(in.KvTypes, 64),
		VramBytes: nonNegUint(in.VramBytes),
		RamBytes:  nonNegUint(in.RamBytes),
		Explain:   truncateString(in.Explain, 500),
	}
	if in.Perf != nil {
		perf := &wire.SystemTelemetryPerf{
			PrefillTokS: mapFigure(in.Perf.PrefillTokS),
			DecodeTokS:  mapFigure(in.Perf.DecodeTokS),
			DecodeBound: mapFigure(in.Perf.DecodeBound),
			LatencyMs:   mapFigure(in.Perf.LatencyMs),
			Calls:       nonNegUint(in.Perf.Calls),
			Failed:      nonNegUint(in.Perf.Failed),
			Tiers:       marshalUintMap(in.Perf.Tiers),
		}
		if in.Perf.Counters != nil {
			perf.Counters = &wire.SystemTelemetryCounters{
				PromptTokens:           nonNegFloat(in.Perf.Counters.PromptTokens),
				PromptSeconds:          nonNegFloat(in.Perf.Counters.PromptSeconds),
				PredictedTokens:        nonNegFloat(in.Perf.Counters.PredictedTokens),
				PredictedSeconds:       nonNegFloat(in.Perf.Counters.PredictedSeconds),
				Processing:             nonNegFloat(in.Perf.Counters.Processing),
				RequestsDeferred:       nonNegFloat(in.Perf.Counters.RequestsDeferred),
				KvCacheUsageRatio:      nonNegFloat(in.Perf.Counters.KvCacheUsageRatio),
				PromptTokensSeconds:    nonNegFloat(in.Perf.Counters.PromptTokensSeconds),
				PredictedTokensSeconds: nonNegFloat(in.Perf.Counters.PredictedTokensSeconds),
			}
		}
		out.Perf = perf
	}
	if len(in.LiveSlots) > 0 {
		limit := min(len(in.LiveSlots), 256)
		out.LiveSlots = make([]wire.SystemTelemetrySlot, 0, limit)
		for _, slot := range in.LiveSlots[:limit] {
			out.LiveSlots = append(out.LiveSlots, wire.SystemTelemetrySlot{
				ID:                 clampNonNegInt64(slot.ID),
				NCtx:               nonNegUint(slot.NCtx),
				Busy:               slot.Busy,
				Phase:              normalizeSlotPhase(slot.Phase),
				PromptTokens:       nonNegUint(slot.PromptTokens),
				PromptDone:         nonNegUint(slot.PromptDone),
				Cached:             nonNegUint(slot.Cached),
				Decoded:            nonNegUint(slot.Decoded),
				NPrompt:            nonNegUint(slot.NPrompt),
				CachedPrefixTokens: nonNegUint(slot.CachedPrefixTokens),
				NDecoded:           nonNegUint(slot.NDecoded),
				TokS:               nonNegFloat(slot.TokS),
				TtftMs:             nonNegFloat(slot.TtftMs),
			})
		}
	}
	return out
}

func mapWhatIf(in *rawWhatIf) *wire.SystemTelemetryWhatIf {
	kvPerTok := in.KvBytesPerToken
	if !isFiniteNonNeg(kvPerTok) {
		kvPerTok = 0
	}
	computePerTok := in.ComputeBytesPerToken
	if !isFiniteNonNeg(computePerTok) {
		computePerTok = 0
	}
	poolKind := ""
	if in.PoolKind == "unified" || in.PoolKind == "discrete" {
		poolKind = in.PoolKind
	}
	return &wire.SystemTelemetryWhatIf{
		Gpu:                   clampNonNegInt64(in.Gpu),
		Window:                clampNonNegInt64(in.Window),
		Slots:                 clampNonNegInt64(in.Slots),
		KvBytesPerToken:       kvPerTok,
		ComputeBytesPerToken:  computePerTok,
		FixedBytes:            clampNonNegInt64(in.FixedBytes),
		RoomBytes:             clampNonNegInt64(in.RoomBytes),
		ActiveWeightBytes:     nonNegUint(in.ActiveWeightBytes),
		WeightsBytes:          nonNegUint(in.WeightsBytes),
		MemoryBwCeilingGbS:    nonNegFloat(in.MemoryBwCeilingGbS),
		PcieBandwidthGbS:      nonNegFloat(in.PcieBandwidthGbS),
		KvDtypeFactors:        marshalFloatMap(in.KvDtypeFactors),
		PoolKind:              poolKind,
		HostRamAvailableBytes: nonNegUint(in.HostRamAvailableBytes),
	}
}

func mapApply(in *rawApply) *wire.SystemTelemetryApply {
	rows := make([]wire.SystemTelemetryApplyRow, 0, min(len(in.Rows), 64))
	for _, row := range in.Rows[:min(len(in.Rows), 64)] {
		rows = append(rows, wire.SystemTelemetryApplyRow{
			ID:     truncateString(row.ID, 64),
			Label:  truncateString(row.Label, 200),
			Detail: truncateString(row.Detail, 300),
			State:  truncateString(row.State, 32),
			Step:   truncateString(row.Step, 64),
			Phase:  truncateString(row.Phase, 64),
			Done:   nonNegUint(row.Done),
			Total:  nonNegUint(row.Total),
		})
	}
	return &wire.SystemTelemetryApply{
		PlanID:    truncateString(in.PlanID, 128),
		StartedAt: truncateString(in.StartedAt, 64),
		UpdatedAt: truncateString(in.UpdatedAt, 64),
		Rollback:  in.Rollback,
		Rows:      rows,
	}
}

func mapHostSensors(in *rawHostSensors) *wire.SystemTelemetryHostSensors {
	cpu := wire.SystemTelemetryCpuSensors{
		OverallPct: wire.SystemTelemetryFigure{Basis: "none"},
	}
	if in.Cpu != nil {
		cpu.OverallPct = mapFigureValue(in.Cpu.OverallPct)
		cpu.LogicalCores = nonNegUint(in.Cpu.LogicalCores)
		if len(in.Cpu.PerCore) > 0 {
			limit := min(len(in.Cpu.PerCore), 512)
			cpu.PerCore = make([]wire.SystemTelemetryCoreUsage, 0, limit)
			for _, core := range in.Cpu.PerCore[:limit] {
				pct := core.UtilPct
				if math.IsNaN(pct) || math.IsInf(pct, 0) {
					continue
				}
				if pct < 0 {
					pct = 0
				} else if pct > 100 {
					pct = 100
				}
				cpu.PerCore = append(cpu.PerCore, wire.SystemTelemetryCoreUsage{
					Core:    clampNonNegInt64(core.Core),
					UtilPct: pct,
				})
			}
		}
	}
	disk := wire.SystemTelemetryDiskSensors{
		ReadMbS:  wire.SystemTelemetryFigure{Basis: "none"},
		WriteMbS: wire.SystemTelemetryFigure{Basis: "none"},
	}
	if in.Disk != nil {
		disk.ReadMbS = mapFigureValue(in.Disk.ReadMbS)
		disk.WriteMbS = mapFigureValue(in.Disk.WriteMbS)
	}
	pressure := wire.SystemTelemetryMemoryPressure{Level: "unknown", Basis: "none"}
	if in.MemoryPressure != nil {
		pressure = wire.SystemTelemetryMemoryPressure{
			Level:          normalizeMemoryPressureLevel(in.MemoryPressure.Level),
			Basis:          normalizeBasis(in.MemoryPressure.Basis),
			AvailableRatio: clampFloat(in.MemoryPressure.AvailableRatio, 0, 1),
			PsiSomeAvg10:   nonNegFloat(in.MemoryPressure.PsiSomeAvg10),
			SwapUsedBytes:  nonNegUint(in.MemoryPressure.SwapUsedBytes),
		}
	}
	watchdog := wire.SystemTelemetryWatchdogHealth{Status: "unknown", Basis: "none"}
	if in.Watchdog != nil {
		watchdog = wire.SystemTelemetryWatchdogHealth{
			Status: normalizeWatchdogStatus(in.Watchdog.Status),
			Basis:  normalizeBasis(in.Watchdog.Basis),
			Detail: truncateString(in.Watchdog.Detail, 500),
		}
	}
	return &wire.SystemTelemetryHostSensors{
		Cpu:            cpu,
		Disk:           disk,
		MemoryPressure: pressure,
		Watchdog:       watchdog,
		Collector:      truncateString(in.Collector, 200),
	}
}

func normalizeBasis(value string) string {
	switch value {
	case "live", "measured", "estimate", "demo", "none":
		return value
	default:
		return "none"
	}
}

func normalizeSource(value string) string {
	switch value {
	case "live", "demo", "empty":
		return value
	default:
		return ""
	}
}

func normalizeBottleneck(value string) string {
	switch value {
	case "memory_bw_bound", "compute_bound", "io_bound", "balanced", "idle":
		return value
	default:
		return ""
	}
}

func normalizeSlotPhase(value string) string {
	switch value {
	case "idle", "prefill", "decoding", "queued":
		return value
	default:
		return ""
	}
}

func normalizeMemoryPressureLevel(value string) string {
	switch value {
	case "nominal", "elevated", "critical", "unknown":
		return value
	default:
		return "unknown"
	}
}

func normalizeWatchdogStatus(value string) string {
	switch value {
	case "clean", "oom", "memory_starved", "crashed", "unknown":
		return value
	default:
		return "unknown"
	}
}

func normalizeWaterfallStatus(value string) string {
	switch value {
	case "streaming", "completed", "deferred":
		return value
	default:
		return "completed"
	}
}

func isFiniteNonNeg(v float64) bool {
	return !math.IsNaN(v) && !math.IsInf(v, 0) && v >= 0
}

func finiteFloat(v *float64) *float64 {
	if v == nil || math.IsNaN(*v) || math.IsInf(*v, 0) {
		return nil
	}
	out := *v
	return &out
}

func nonNegFloat(v *float64) *float64 {
	if v == nil || !isFiniteNonNeg(*v) {
		return nil
	}
	out := *v
	return &out
}

func clampFloat(v *float64, low, high float64) *float64 {
	if v == nil || math.IsNaN(*v) || math.IsInf(*v, 0) {
		return nil
	}
	out := *v
	if out < low {
		out = low
	} else if out > high {
		out = high
	}
	return &out
}

func clampNonNegInt64(v int64) uint64 {
	if v < 0 {
		return 0
	}
	return uint64(v)
}

func nonNegUint(v *int64) *uint64 {
	if v == nil || *v < 0 {
		return nil
	}
	out := uint64(*v)
	return &out
}

func marshalUintMap(values map[string]int64) json.RawMessage {
	if len(values) == 0 {
		return nil
	}
	clean := make(map[string]uint64, len(values))
	for key, val := range values {
		if key == "" || val < 0 || len(clean) >= 64 {
			continue
		}
		clean[truncateString(key, 120)] = uint64(val)
	}
	if len(clean) == 0 {
		return nil
	}
	encoded, err := json.Marshal(clean)
	if err != nil {
		return nil
	}
	return encoded
}

func marshalFloatMap(values map[string]float64) json.RawMessage {
	if len(values) == 0 {
		return nil
	}
	clean := make(map[string]float64, len(values))
	for key, val := range values {
		if key == "" || !isFiniteNonNeg(val) || len(clean) >= 64 {
			continue
		}
		clean[truncateString(key, 64)] = val
	}
	if len(clean) == 0 {
		return nil
	}
	encoded, err := json.Marshal(clean)
	if err != nil {
		return nil
	}
	return encoded
}

func truncateString(value string, maxLen int) string {
	if len(value) <= maxLen {
		return value
	}
	return value[:maxLen]
}

func truncateOptionalString(value *string, maxLen int) string {
	if value == nil {
		return ""
	}
	return truncateString(*value, maxLen)
}
