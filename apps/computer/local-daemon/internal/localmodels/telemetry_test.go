package localmodels

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

func TestParseSystemTelemetrySnapshotAllowlistsAndNormalizes(t *testing.T) {
	raw := []byte(`{
		"schema": "localmodels.stack-view/v1",
		"schema_version": "1.1",
		"generated_at": "2026-11-26T10:00:00+00:00",
		"source": "live",
		"lang": "en",
		"plan_id": "plan-42",
		"secret_prompt": "must never survive parsing",
		"host": {"hostname": "workstation-1", "system": "Linux x86_64", "tier": "gpu_24g"},
		"gateway": {
			"kind": "bifrost",
			"addr": "127.0.0.1:18480",
			"route": "localmodels/qwen",
			"in_flight": 2,
			"client_lanes": {"pi": 2},
			"p50_ttft_ms": {"value": 142.5, "basis": "live", "note": "Median TTFT"}
		},
		"components": [{
			"id": "llm",
			"role": "llm",
			"title": "Primary LLM",
			"model": "qwen3-8b",
			"quant": "Q4_K_M",
			"state": "serving",
			"health": "ok",
			"vram_bytes": 12000000000,
			"ram_bytes": 512000000,
			"perf": {
				"decode_tok_s": {"value": 74.2, "basis": "live", "note": "live"},
				"counters": {"predicted_tokens": 1200, "kv_cache_usage_ratio": 0.34, "requests_deferred": 0}
			},
			"live_slots": [{
				"id": 0,
				"n_ctx": 32768,
				"busy": true,
				"phase": "decoding",
				"prompt_tokens": 4096,
				"cached": 3000,
				"decoded": 128,
				"tok_s": 74.2,
				"ttft_ms": 110.5,
				"prompt": "sensitive user prompt must be stripped"
			}]
		}],
		"gpus": [{
			"index": 0,
			"name": "NVIDIA GeForce RTX 4090",
			"total_bytes": 25769803776,
			"used_bytes": 12884901888,
			"bandwidth_gb_s": 1008.0,
			"holders": ["llama-server"]
		}],
		"gpu_load": [{
			"index": 0,
			"util_pct": 88.5,
			"mem_ctrl_util_pct": 79.0,
			"power_w": 310.2,
			"power_limit_w": 450.0,
			"temp_c": 67.0,
			"basis": "live",
			"source": "nvml"
		}],
		"ram": {"total_bytes": 68719476736, "available_bytes": 42949672960},
		"what_if": {
			"gpu": 0,
			"window": 32768,
			"slots": 4,
			"kv_bytes_per_token": 131072,
			"compute_bytes_per_token": 16384,
			"fixed_bytes": 8000000000,
			"room_bytes": 22000000000,
			"active_weight_bytes": 6500000000,
			"kv_dtype_factors": {"f16": 1.0, "q8_0": 0.53125},
			"pool_kind": "discrete"
		},
		"sensors": {
			"cpu": {
				"overall_pct": {"value": 31.4, "basis": "live", "note": "/proc/stat"},
				"per_core": [{"core": 0, "util_pct": 45.0}],
				"logical_cores": 16
			},
			"disk": {
				"read_mb_s": {"value": 12.5, "basis": "live", "note": "disk"},
				"write_mb_s": {"value": null, "basis": "none", "note": "n/a"}
			},
			"memory_pressure": {"level": "nominal", "basis": "live", "available_ratio": 0.625, "psi_some_avg10": 0.0, "swap_used_bytes": 0},
			"watchdog": {"status": "clean", "basis": "live", "detail": "All deployed services healthy"},
			"collector": "NVML"
		},
		"effective_decode_bw_gb_s": {"value": 482.3, "basis": "measured", "note": "decode * weights"},
		"memory_bw_ceiling_gb_s": {"value": 1008.0, "basis": "estimate", "note": "vendor spec"},
		"bottleneck": "memory_bw_bound",
		"waterfall": [{
			"request_id": "req-1",
			"at": "2026-11-26T09:59:59+00:00",
			"client_id": "pi",
			"model_id": "qwen3-8b",
			"status": "completed",
			"gateway_ms": 2.1,
			"ttft_ms": 110.5,
			"decode_ms": 1720.0,
			"prompt_tokens": 4096,
			"completion_tokens": 128,
			"cached_prefix_pct": 73.2,
			"decode_tok_s": 74.4,
			"basis": "live"
		}],
		"in_flight": 2,
		"client_lanes": {"pi": 2}
	}`)

	snapshot, err := ParseSystemTelemetrySnapshot(raw)
	if err != nil {
		t.Fatalf("ParseSystemTelemetrySnapshot failed: %v", err)
	}
	if snapshot.Schema != "localmodels.stack-view/v1" || snapshot.SchemaVersion != "1.1" || snapshot.Bottleneck != "memory_bw_bound" {
		t.Fatalf("unexpected top-level snapshot fields: %+v", snapshot)
	}
	if snapshot.EffectiveDecodeBwGbS == nil || snapshot.EffectiveDecodeBwGbS.Value == nil || *snapshot.EffectiveDecodeBwGbS.Value != 482.3 {
		t.Fatalf("unexpected effective_decode_bw_gb_s: %+v", snapshot.EffectiveDecodeBwGbS)
	}
	if snapshot.Sensors == nil || snapshot.Sensors.Disk.WriteMbS.Value != nil || snapshot.Sensors.Disk.WriteMbS.Basis != "none" {
		t.Fatalf("unexpected sensors disk write null handling: %+v", snapshot.Sensors)
	}
	if len(snapshot.Components) != 1 || len(snapshot.Components[0].LiveSlots) != 1 || snapshot.Components[0].LiveSlots[0].Phase != "decoding" {
		t.Fatalf("unexpected components/live_slots: %+v", snapshot.Components)
	}
	encoded, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatalf("marshal snapshot: %v", err)
	}
	if strings.Contains(string(encoded), "must never survive") || strings.Contains(string(encoded), "sensitive user prompt") {
		t.Fatalf("unexpected non-allowlisted field leaked into wire payload: %s", encoded)
	}
}

// TestTelemetryHelperProcess runs as a child subprocess for TelemetryCollector tests.
func TestTelemetryHelperProcess(t *testing.T) {
	mode := os.Getenv("LINGER_TELEMETRY_TEST_HELPER")
	if mode == "" {
		return
	}
	switch mode {
	case "unsupported":
		_, _ = fmt.Fprintln(os.Stderr, "usage: localmodels stack view [-h] [--json]\nlocalmodels: error: unrecognized arguments: --live-tick --stream")
		os.Exit(2)
	case "stream":
		if pidFile := os.Getenv("LINGER_TELEMETRY_TEST_PIDFILE"); pidFile != "" {
			_ = os.WriteFile(pidFile, []byte(strconv.Itoa(os.Getpid())), 0o600)
		}
		sigs := make(chan os.Signal, 1)
		signal.Notify(sigs, syscall.SIGTERM, syscall.SIGINT)
		seq := 0
		ticker := time.NewTicker(25 * time.Millisecond)
		defer ticker.Stop()
		for {
			seq++
			line := fmt.Sprintf(`{"schema":"localmodels.stack-view/v1","schema_version":"1.1","generated_at":"2026-11-26T10:00:%02dZ","source":"live","bottleneck":"idle","in_flight":%d}`, seq%60, seq)
			_, _ = fmt.Fprintln(os.Stdout, line)
			select {
			case <-sigs:
				os.Exit(0)
			case <-ticker.C:
			}
		}
	default:
		os.Exit(1)
	}
}

func helperTelemetryCmd(t *testing.T, mode, pidFile string) func(time.Duration) *exec.Cmd {
	t.Helper()
	return func(time.Duration) *exec.Cmd {
		cmd := exec.Command(os.Args[0], "-test.run=^TestTelemetryHelperProcess$")
		cmd.Env = append(os.Environ(),
			"LINGER_TELEMETRY_TEST_HELPER="+mode,
			"LINGER_TELEMETRY_TEST_PIDFILE="+pidFile,
		)
		return cmd
	}
}

func TestTelemetryCollectorLeaseStartRenewAndUnsubscribe(t *testing.T) {
	var spawns atomic.Int32
	pidFile := t.TempDir() + "/child.pid"
	updates := make(chan TelemetryUpdate, 32)
	factory := helperTelemetryCmd(t, "stream", pidFile)

	collector := NewTelemetryCollector(TelemetryOptions{
		CommandFactory: func(interval time.Duration) *exec.Cmd {
			spawns.Add(1)
			return factory(interval)
		},
		Publish: func(update TelemetryUpdate) {
			select {
			case updates <- update:
			default:
			}
		},
		ShutdownGrace: 500 * time.Millisecond,
	})
	defer collector.Close()

	// Zero subprocesses while idle.
	if spawns.Load() != 0 {
		t.Fatalf("expected 0 spawns while idle, got %d", spawns.Load())
	}

	collector.Subscribe(2*time.Second, 250*time.Millisecond)
	select {
	case first := <-updates:
		if first.Status != TelemetryStatusOK || first.Snapshot == nil {
			t.Fatalf("expected ok snapshot, got %+v", first)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for first telemetry tick")
	}

	// Renewing the lease must keep the same subprocess without respawning.
	collector.Subscribe(2*time.Second, 250*time.Millisecond)
	if spawns.Load() != 1 {
		t.Fatalf("expected lease renewal to keep 1 subprocess, got %d spawns", spawns.Load())
	}

	collector.StopAndWait()

	// Verify no lingering child process after unsubscribe.
	rawPID, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatalf("read helper pid file: %v", err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(rawPID)))
	if err != nil || pid <= 0 {
		t.Fatalf("invalid helper pid %q: %v", string(rawPID), err)
	}
	if proc, findErr := os.FindProcess(pid); findErr == nil {
		if sigErr := proc.Signal(syscall.Signal(0)); sigErr == nil {
			t.Fatalf("child process %d is still alive after unsubscribe", pid)
		}
	}
}

func TestTelemetryCollectorLeaseExpiryStopsCollector(t *testing.T) {
	updates := make(chan TelemetryUpdate, 32)
	collector := NewTelemetryCollector(TelemetryOptions{
		CommandFactory: helperTelemetryCmd(t, "stream", ""),
		Publish: func(update TelemetryUpdate) {
			select {
			case updates <- update:
			default:
			}
		},
		ShutdownGrace: 300 * time.Millisecond,
	})
	defer collector.Close()

	// Minimum lease TTL is clamped to 1s; wait for first tick then let lease expire.
	collector.Subscribe(time.Second, 250*time.Millisecond)
	select {
	case <-updates:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for initial telemetry tick")
	}

	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		collector.mu.Lock()
		active := collector.active
		collector.mu.Unlock()
		if !active {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatal("expected collector lease to expire and stop automatically")
}

func TestTelemetryCollectorUnsupportedKitAvoidsRetryStorm(t *testing.T) {
	var spawns atomic.Int32
	var mu sync.Mutex
	var got []TelemetryUpdate
	factory := helperTelemetryCmd(t, "unsupported", "")

	collector := NewTelemetryCollector(TelemetryOptions{
		CommandFactory: func(interval time.Duration) *exec.Cmd {
			spawns.Add(1)
			return factory(interval)
		},
		Publish: func(update TelemetryUpdate) {
			mu.Lock()
			got = append(got, update)
			mu.Unlock()
		},
	})
	defer collector.Close()

	collector.Subscribe(5*time.Second, time.Second)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		n := len(got)
		mu.Unlock()
		if n >= 1 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	collector.StopAndWait()

	mu.Lock()
	if len(got) != 1 || got[0].Status != TelemetryStatusUnsupported || got[0].Reason == nil || got[0].Reason.Code != CodeTelemetryLiveTickUnsupported {
		t.Fatalf("expected single LIVE_TICK_UNSUPPORTED update, got %+v", got)
	}
	mu.Unlock()

	// Subsequent Subscribe must return cached unsupported without respawning.
	collector.Subscribe(5*time.Second, time.Second)
	if spawns.Load() != 1 {
		t.Fatalf("expected 1 total spawn without retry storm, got %d", spawns.Load())
	}
	mu.Lock()
	if len(got) != 2 || got[1].Status != TelemetryStatusUnsupported {
		t.Fatalf("expected cached unsupported reply on second subscribe, got %+v", got)
	}
	mu.Unlock()
}

func TestTelemetryCollectorWithoutToolReportsToolNotInstalled(t *testing.T) {
	var got TelemetryUpdate
	collector := NewTelemetryCollector(TelemetryOptions{
		Publish: func(update TelemetryUpdate) { got = update },
	})
	defer collector.Close()

	collector.Subscribe(10*time.Second, time.Second)
	if got.Status != TelemetryStatusUnsupported || got.Reason == nil || got.Reason.Code != CodeTelemetryToolNotInstalled {
		t.Fatalf("expected TOOL_NOT_INSTALLED, got %+v", got)
	}
}
