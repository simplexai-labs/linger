package native

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestPiCatalogPreservesContextCauseAfterChildCleanup(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX shell")
	}
	for _, kind := range []string{"deadline", "cancel"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			program := filepath.Join(root, "pi")
			pidFile := filepath.Join(root, "pid")
			if err := os.WriteFile(program, []byte("#!/bin/sh\necho $$ > \"$HOME/pid\"\nexec /bin/sleep 60\n"), 0700); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancelCause(t.Context())
			defer cancel(nil)
			bounded, stop := context.WithTimeout(ctx, 400*time.Millisecond)
			defer stop()
			done := make(chan error, 1)
			go func() {
				_, err := DiscoverPiModels(bounded, NewInvocation(program, nil).WithEnvironment(map[string]string{"HOME": root}))
				done <- err
			}()
			var encoded []byte
			deadline := time.Now().Add(3 * time.Second)
			for time.Now().Before(deadline) {
				if data, err := os.ReadFile(pidFile); err == nil {
					encoded = data
					break
				}
				time.Sleep(time.Millisecond * 5)
			}
			if len(encoded) == 0 {
				t.Fatal("catalog child did not start")
			}
			want := context.DeadlineExceeded
			if kind == "cancel" {
				want = context.Canceled
				cancel(errors.New("secret-cancel-cause"))
			}
			err := <-done
			if !errors.Is(err, want) || strings.Contains(err.Error(), "secret") {
				t.Fatalf("context cause lost or disclosed: %v", err)
			}
			pid, err := strconv.Atoi(strings.TrimSpace(string(encoded)))
			if err != nil {
				t.Fatal(err)
			}
			child, err := os.FindProcess(pid)
			if err != nil {
				t.Fatal(err)
			}
			defer child.Release()
			if child.Signal(syscall.Signal(0)) == nil {
				t.Fatal("catalog child survived cancellation")
			}
		})
	}
}

func TestPiCatalogMasksNonContextFailure(t *testing.T) {
	inv := fixtureInvocation(t, "print", map[string]string{"FIXTURE_STDOUT": "secret-output", "FIXTURE_EXIT": "1"})
	_, err := DiscoverPiModels(t.Context(), inv)
	if !errors.Is(err, errPiNoModels) || strings.Contains(err.Error(), "secret") {
		t.Fatalf("unsafe catalog failure: %v", err)
	}
}

func TestPiCatalogResolvesFallbackDefaultReasoningEffort(t *testing.T) {
	state := piCatalogState{ThinkingLevel: "medium"}
	state.Model.Provider = "localmodels-library"
	state.Model.ID = "spark"
	list, err := piCatalogList(
		state,
		[]json.RawMessage{
			// Default model whose thinkingLevelMap excludes "medium" (Spark-X2.6-4B shape).
			json.RawMessage(`{"provider":"localmodels-library","id":"spark","name":"Spark-X2.6-4B","reasoning":true,"thinkingLevelMap":{"off":0,"minimal":null,"low":1,"medium":null,"high":2}}`),
			// Non-default Model Library model with full levels and no explicit default.
			json.RawMessage(`{"provider":"localmodels-library","id":"qwen36","name":"Qwen3.6-35B-A3B","reasoning":true,"thinkingLevelMap":{"off":0,"minimal":null,"low":1,"medium":2,"high":3}}`),
			// Non-default model supporting only none and high.
			json.RawMessage(`{"provider":"localmodels-library","id":"highonly","name":"HighOnly","reasoning":true,"thinkingLevelMap":{"off":0,"minimal":null,"low":null,"medium":null,"high":2}}`),
			// Non-default model supporting only none and xhigh.
			json.RawMessage(`{"provider":"localmodels-library","id":"xhighonly","name":"XHighOnly","reasoning":true,"thinkingLevelMap":{"off":0,"minimal":null,"low":null,"medium":null,"high":null,"xhigh":4}}`),
			// Non-default model supporting only none.
			json.RawMessage(`{"provider":"localmodels-library","id":"noneonly","name":"NoneOnly","reasoning":true,"thinkingLevelMap":{"off":0,"minimal":null,"low":null,"medium":null,"high":null}}`),
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"localmodels-library/spark":     "low",
		"localmodels-library/qwen36":    "medium",
		"localmodels-library/highonly":  "high",
		"localmodels-library/xhighonly": "xhigh",
		"localmodels-library/noneonly":  "none",
	}
	if len(list.Models) != len(want) {
		t.Fatalf("models = %+v", list.Models)
	}
	for _, model := range list.Models {
		if model.Effort == nil || model.Effort.Default != want[model.ID] {
			t.Fatalf("%s effort = %+v, want default %q", model.ID, model.Effort, want[model.ID])
		}
	}
}
