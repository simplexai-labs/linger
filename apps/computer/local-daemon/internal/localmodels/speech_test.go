package localmodels

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	wire "github.com/simplexai-labs/linger/contracts-go/runnergateway"
)

func fakeSpeechEnv() map[string]string {
	return map[string]string{"LOCALMODELS_FAKE_TOOL": "1"}
}

func TestLocalmodelsVersionAtLeast(t *testing.T) {
	cases := []struct {
		actual  string
		minimum string
		want    bool
		wantOK  bool
	}{
		{"0.1.0.dev38", firstLocalmodelsSpeechVersion, false, true},
		{"0.1.0.dev59", firstLocalmodelsSpeechVersion, false, true},
		{"0.1.0.dev60", firstLocalmodelsSpeechVersion, false, true},
		{"0.1.0.dev61", firstLocalmodelsSpeechVersion, true, true},
		{"0.1.0.dev62", firstLocalmodelsSpeechVersion, true, true},
		{"0.1.0.dev100", firstLocalmodelsSpeechVersion, true, true},
		{"0.1.0a1.dev1", firstLocalmodelsSpeechVersion, true, true},
		{"0.1.0a1", firstLocalmodelsSpeechVersion, true, true},
		{"0.1.0b1", firstLocalmodelsSpeechVersion, true, true},
		{"0.1.0rc1", firstLocalmodelsSpeechVersion, true, true},
		{"0.1.0", firstLocalmodelsSpeechVersion, true, true},
		{"0.1.0.post1", firstLocalmodelsSpeechVersion, true, true},
		{"0.2.0.dev1", firstLocalmodelsSpeechVersion, true, true},
		{"0.9.0", firstLocalmodelsSpeechVersion, true, true},
		{"1.0.0", firstLocalmodelsSpeechVersion, true, true},
		{"0.0.9", firstLocalmodelsSpeechVersion, false, true},
		{"0.1.0.dev61+local1", firstLocalmodelsSpeechVersion, true, true},
		{"v0.1.0.dev60", firstLocalmodelsSpeechVersion, false, true},
		{"not-a-version", firstLocalmodelsSpeechVersion, false, false},
		{"", firstLocalmodelsSpeechVersion, false, false},
	}
	for _, tc := range cases {
		got, ok := localmodelsVersionAtLeast(tc.actual, tc.minimum)
		if ok != tc.wantOK || got != tc.want {
			t.Errorf("localmodelsVersionAtLeast(%q, %q) = (%v, %v), want (%v, %v)",
				tc.actual, tc.minimum, got, ok, tc.want, tc.wantOK)
		}
	}
}

func TestSpeechLibraryGracefulUnsupportedByVersion(t *testing.T) {
	fake := newFakeTool(t)
	// Older kit (0.1.0.dev60) fails `speech` with arbitrary opaque stderr (not
	// Python argparse prose), while `library status --json` structurally reports
	// tool_version 0.1.0.dev60.
	oldStatus := status()
	oldStatus["tool_version"] = "0.1.0.dev60"
	fake.write("status.json", oldStatus)
	if err := os.WriteFile(filepath.Join(fake.state, "speech-exit"), []byte("2\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(fake.state, "speech-stderr"), []byte("opaque parser failure\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	var published []wire.LocalSpeechSnapshot
	lib := NewSpeech(SpeechOptions{
		Tool:         &fake.tool,
		Environment:  fakeSpeechEnv(),
		JobDirectory: filepath.Join(t.TempDir(), "jobs"),
		Publish:      func(s wire.LocalSpeechSnapshot) { published = append(published, s) },
	})
	defer lib.Close()

	snap := lib.Refresh(context.Background())
	if snap.Available {
		t.Fatalf("expected unavailable snapshot, got %+v", snap)
	}
	if snap.Reason == nil || snap.Reason.Code != CodeSpeechUnsupported {
		t.Fatalf("expected SPEECH_UNSUPPORTED, got %+v", snap.Reason)
	}
	if !strings.Contains(snap.Reason.Detail, "0.1.0.dev60") {
		t.Fatalf("expected version detail, got %q", snap.Reason.Detail)
	}
	if len(published) != 1 {
		t.Fatalf("expected 1 published snapshot, got %d", len(published))
	}

	// Subsequent actions and transcriptions immediately return SPEECH_UNSUPPORTED
	// from the cached structural probe.
	refusal, answered := lib.Act(context.Background(), SpeechAction{Name: SpeechActionUnload}, time.Now().Add(5*time.Second))
	if !answered || refusal == nil || refusal.Code != CodeSpeechUnsupported {
		t.Fatalf("expected SPEECH_UNSUPPORTED refusal on Act, got answered=%v refusal=%+v", answered, refusal)
	}

	_, err := lib.Transcribe(context.Background(), SpeechTranscribeRequest{
		AudioWavBase64: base64.StdEncoding.EncodeToString([]byte("RIFF\x24\x00\x00\x00WAVEfmt ")),
	})
	var transcribeErr *SpeechTranscribeError
	if !errors.As(err, &transcribeErr) || transcribeErr.Code != CodeSpeechUnsupported {
		t.Fatalf("expected SPEECH_UNSUPPORTED transcribe error, got %v", err)
	}
}

func TestSpeechLibraryNewerKitFailureReportsToolFailed(t *testing.T) {
	fake := newFakeTool(t)
	// Newer kit (0.1.0.dev61) reports speech support structurally, so a crash
	// during `speech status` must surface TOOL_FAILED rather than SPEECH_UNSUPPORTED.
	newStatus := status()
	newStatus["tool_version"] = "0.1.0.dev61"
	fake.write("status.json", newStatus)
	if err := os.WriteFile(filepath.Join(fake.state, "speech-exit"), []byte("1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(fake.state, "speech-stderr"), []byte("invalid choice: 'speech'\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	lib := NewSpeech(SpeechOptions{
		Tool:         &fake.tool,
		Environment:  fakeSpeechEnv(),
		JobDirectory: filepath.Join(t.TempDir(), "jobs"),
	})
	defer lib.Close()

	snap := lib.Refresh(context.Background())
	if snap.Available || snap.Reason == nil || snap.Reason.Code != CodeToolFailed {
		t.Fatalf("expected TOOL_FAILED for 0.1.0.dev61 failure, got %+v", snap.Reason)
	}

	refusal, answered := lib.Act(context.Background(), SpeechAction{Name: SpeechActionUnload}, time.Now().Add(5*time.Second))
	if !answered || refusal == nil || refusal.Code != CodeToolFailed {
		t.Fatalf("expected TOOL_FAILED refusal on Act, got answered=%v refusal=%+v", answered, refusal)
	}
}

func TestSpeechLibraryStatusActionsAndTranscribe(t *testing.T) {
	keyFile := filepath.Join(t.TempDir(), "speech.key")
	if err := os.WriteFile(keyFile, []byte("secret-loopback-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	var mu sync.Mutex
	var lastAuth, lastModel, lastLang, lastUseGPU, lastKeep string
	var lastAudioLen int
	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/health":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"status":"ok","state":"standby","active_model":null,"effective_device":null}`))
		case "/v1/audio/transcriptions":
			if err := r.ParseMultipartForm(4 << 20); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			file, _, err := r.FormFile("file")
			if err != nil {
				http.Error(w, "missing file", http.StatusBadRequest)
				return
			}
			data, _ := io.ReadAll(file)
			_ = file.Close()
			mu.Lock()
			lastAuth = r.Header.Get("Authorization")
			lastModel = r.FormValue("model")
			lastLang = r.FormValue("language")
			lastUseGPU = r.FormValue("use_gpu")
			lastKeep = r.FormValue("keep_loaded_seconds")
			lastAudioLen = len(data)
			mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{
				"text": "Hello local voice.",
				"language": "en",
				"duration": 1.5,
				"model": "sensevoice-small",
				"requested_device": "gpu",
				"effective_device": "cpu",
				"fallback_reason": "cpu_optimal_for_int8",
				"segments": [{"start": 0.0, "end": 1.5, "text": "Hello local voice."}]
			}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer sidecar.Close()

	fake := newFakeTool(t)
	fake.write("speech-status.json", map[string]any{
		"schema":       "localmodels.speech-status/v1",
		"tool_version": "0.1.0.dev61",
		"observed_at":  "2026-11-26T13:20:00Z",
		"config": map[string]any{
			"model_id":            "sensevoice-small",
			"use_gpu":             true,
			"keep_loaded_seconds": 900,
			"language":            "auto",
		},
		"runtime": map[string]any{
			"running":                true,
			"state":                  "standby",
			"base_url":               sidecar.URL,
			"key_file":               keyFile,
			"active_model":           nil,
			"engine":                 nil,
			"requested_device":       "gpu",
			"effective_device":       nil,
			"fallback_reason":        nil,
			"fallback_detail":        nil,
			"vram_used_bytes":        0,
			"ram_used_bytes":         0,
			"keep_loaded_seconds":    900,
			"idle_remaining_seconds": nil,
			"active_sessions":        0,
		},
		"models": []any{map[string]any{
			"id":                  "sensevoice-small",
			"name":                "SenseVoice Small (INT8)",
			"engine":              "sherpa-onnx",
			"languages":           []string{"zh", "en", "ja", "ko", "yue"},
			"language_count":      5,
			"quality_rating":      "fast-cjk",
			"license":             "FunASR-MODEL-LICENSE-1.1",
			"license_url":         "https://huggingface.co/FunAudioLLM/SenseVoiceSmall/blob/main/MODEL_LICENSE",
			"commercial_notice":   "Custom license",
			"disk_size_bytes":     240123904,
			"vram_estimate_bytes": 0,
			"ram_estimate_bytes":  629145600,
			"gpu_supported":       false,
			"state":               "idle",
			"active":              false,
			"download":            nil,
			"error":               nil,
		}},
	})
	fake.write("speech-start.json", map[string]any{
		"schema": "localmodels.speech-runtime/v1",
		"runtime": map[string]any{
			"running":  true,
			"state":    "standby",
			"base_url": sidecar.URL,
			"key_file": keyFile,
		},
	})

	var pubMu sync.Mutex
	var published []wire.LocalSpeechSnapshot
	lib := NewSpeech(SpeechOptions{
		Tool:         &fake.tool,
		Environment:  fakeSpeechEnv(),
		JobDirectory: filepath.Join(t.TempDir(), "jobs"),
		Publish: func(s wire.LocalSpeechSnapshot) {
			pubMu.Lock()
			published = append(published, s)
			pubMu.Unlock()
		},
	})
	defer lib.Close()

	snap := lib.Refresh(context.Background())
	if !snap.Available || len(snap.Models) != 1 || snap.Models[0].ID != "sensevoice-small" {
		t.Fatalf("unexpected speech status snapshot: %+v", snap)
	}
	rawWire, _ := json.Marshal(snap)
	if len(rawWire) == 0 || strings.Contains(string(rawWire), "key_file") || strings.Contains(string(rawWire), "base_url") {
		t.Fatalf("wire snapshot must never leak key_file or base_url: %s", string(rawWire))
	}

	// Refused download returns structured refusal.
	refusal, answered := lib.Act(context.Background(), SpeechAction{Name: SpeechActionDownload, Model: "bad-model"}, time.Now().Add(5*time.Second))
	if !answered || refusal == nil || refusal.Code != "MODEL_UNKNOWN" {
		t.Fatalf("expected MODEL_UNKNOWN refusal, got answered=%v refusal=%+v", answered, refusal)
	}
	if refusal.Detail != "unknown" {
		t.Fatalf("expected refusal detail from the event message, got %q", refusal.Detail)
	}

	// A JSON verb's pretty-printed error document is still a structured refusal.
	refusal, answered = lib.Act(context.Background(), SpeechAction{Name: SpeechActionRemove, Model: "bad-model"}, time.Now().Add(5*time.Second))
	if !answered || refusal == nil || refusal.Code != "MODEL_UNKNOWN" || refusal.Detail != "unknown speech model" {
		t.Fatalf("expected MODEL_UNKNOWN refusal from indented JSON, got answered=%v refusal=%+v", answered, refusal)
	}

	// Accepted download returns nil refusal.
	refusal, answered = lib.Act(context.Background(), SpeechAction{Name: SpeechActionDownload, Model: "sensevoice-small"}, time.Now().Add(5*time.Second))
	if !answered || refusal != nil {
		t.Fatalf("expected accepted download, got answered=%v refusal=%+v", answered, refusal)
	}

	// Synchronous configure returns nil refusal.
	useGPU := true
	keep := int64(300)
	refusal, answered = lib.Act(context.Background(), SpeechAction{
		Name: SpeechActionConfigure, UseGPU: &useGPU, KeepLoadedSeconds: &keep, Language: "zh",
	}, time.Now().Add(5*time.Second))
	if !answered || refusal != nil {
		t.Fatalf("expected accepted configure, got answered=%v refusal=%+v", answered, refusal)
	}

	// Transcribe sends multipart WAV with Bearer auth and parses structured response.
	wav := []byte("RIFF\x24\x00\x00\x00WAVEfmt ")
	res, err := lib.Transcribe(context.Background(), SpeechTranscribeRequest{
		ModelID:           "sensevoice-small",
		Language:          "en",
		UseGPU:            &useGPU,
		KeepLoadedSeconds: &keep,
		AudioWavBase64:    base64.StdEncoding.EncodeToString(wav),
	})
	if err != nil {
		t.Fatalf("Transcribe failed: %v", err)
	}
	if res.Text != "Hello local voice." || res.EffectiveDevice != "cpu" || res.FallbackReason != "cpu_optimal_for_int8" || len(res.Segments) != 1 {
		t.Fatalf("unexpected transcribe result: %+v", res)
	}
	mu.Lock()
	defer mu.Unlock()
	if lastAuth != "Bearer secret-loopback-token" || lastModel != "sensevoice-small" || lastLang != "en" || lastUseGPU != "true" || lastKeep != "300" || lastAudioLen != len(wav) {
		t.Fatalf("unexpected sidecar request: auth=%q model=%q lang=%q gpu=%q keep=%q bytes=%d", lastAuth, lastModel, lastLang, lastUseGPU, lastKeep, lastAudioLen)
	}
}

func TestParseSpeechRefusalMatchesKitErrorEvents(t *testing.T) {
	cases := []struct {
		name   string
		stdout string
		code   string
		detail string
	}{
		{
			name:   "compact JSONL error after progress",
			stdout: `{"schema":"localmodels.speech-event/v1","event":"progress","model":"m","step":"download","done_bytes":1,"total_bytes":2}` + "\n" + `{"schema":"localmodels.speech-event/v1","event":"error","ok":false,"code":"DISK_INSUFFICIENT","message":"need 1 GiB","model":"m"}` + "\n",
			code:   "DISK_INSUFFICIENT",
			detail: "need 1 GiB",
		},
		{
			name:   "indented JSON error",
			stdout: "{\n \"schema\": \"localmodels.speech-event/v1\",\n \"event\": \"error\",\n \"ok\": false,\n \"code\": \"INVALID_STATE\",\n \"message\": \"not downloading\"\n}\n",
			code:   "INVALID_STATE",
			detail: "not downloading",
		},
		{
			name:   "kit-only code falls back to UNKNOWN_ERROR",
			stdout: `{"schema":"localmodels.speech-event/v1","event":"error","ok":false,"code":"RUNTIME_ERROR","message":"boom"}`,
			code:   "UNKNOWN_ERROR",
			detail: "boom",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			refusal := parseSpeechRefusal(tc.stdout, "")
			if refusal == nil || refusal.Code != tc.code || refusal.Detail != tc.detail {
				t.Fatalf("got %+v, want code %s detail %q", refusal, tc.code, tc.detail)
			}
		})
	}
	for _, stdout := range []string{
		`{"schema":"localmodels.speech-event/v1","event":"result","ok":true}`,
		`{"schema":"localmodels.speech-runtime/v1","ok":true,"runtime":{}}`,
		"not json",
	} {
		if refusal := parseSpeechRefusal(stdout, ""); refusal != nil {
			t.Fatalf("expected no refusal for %q, got %+v", stdout, refusal)
		}
	}
}
