package document

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
)

func TestLatestReadEvidenceSeparatesReuseFromCacheMisses(t *testing.T) {
	var output bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&output, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	for _, reader := range []string{"human", "agent"} {
		observeLatestRead(context.Background(), reader, "markdown", "miss", "document_private", "revision_old")
		observeLatestRead(context.Background(), reader, "markdown", "hit", "document_private", "revision_old")
	}
	observeLatestRead(context.Background(), "human", "markdown", "hit", "document_private", "revision_new")
	seen := map[string]int{}
	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	if len(lines) != 3 {
		t.Fatalf("successful read events=%d want 3", len(lines))
	}
	for _, line := range lines {
		var event map[string]any
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			t.Fatal(err)
		}
		if event["event"] != "document_latest_read" || strings.Contains(line, "document_private") || strings.Contains(line, "revision_old") {
			t.Fatalf("invalid read evidence: %s", line)
		}
		seen[event["document_key"].(string)+event["revision_key"].(string)+event["format"].(string)]++
	}
	// Across both entry points, three resolutions of two immutable versions
	// have one repeat. The two misses must not inflate this ratio.
	if len(seen) != 2 {
		t.Fatalf("unique serializations=%d want 2", len(seen))
	}
}
