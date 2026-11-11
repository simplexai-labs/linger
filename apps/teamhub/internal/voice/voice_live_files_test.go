package voice

import (
	"bytes"
	"encoding/base64"
	"io"
	"testing"
)

func TestVoiceLiveChunksRejectMissingOrInconsistentBoundaries(t *testing.T) {
	good := map[string]any{"data_base64": base64.StdEncoding.EncodeToString([]byte("hello")), "size": 5, "modified_ns": "1234567890123456789", "offset": 0, "next_offset": 5, "eof": true}
	chunk, err := decodeVoiceLiveChunk(good)
	if err != nil || string(chunk.data) != "hello" {
		t.Fatalf("valid chunk=%v %v", chunk, err)
	}
	for key, value := range map[string]any{"modified_ns": "", "size": 4, "offset": -1, "next_offset": 9, "data_base64": "bad*", "eof": false} {
		bad := map[string]any{}
		for k, v := range good {
			bad[k] = v
		}
		bad[key] = value
		if _, err := decodeVoiceLiveChunk(bad); err == nil {
			t.Fatalf("accepted inconsistent %s", key)
		}
	}
}

// chunkedFile serves one file in chunks, optionally changing it after the
// first read.
func chunkedFile(content []byte, size int, modified []string, calls *int) func(int64) (map[string]any, error) {
	return func(offset int64) (map[string]any, error) {
		end := min(int(offset)+size, len(content))
		stamp := modified[min(*calls, len(modified)-1)]
		*calls++
		return map[string]any{
			"data_base64": base64.StdEncoding.EncodeToString(content[offset:end]), "size": len(content),
			"modified_ns": stamp, "offset": offset, "next_offset": end, "eof": end == len(content),
		}, nil
	}
}

func TestCopyVoiceLiveFileReadsEveryChunkAndRefusesAChangingFile(t *testing.T) {
	content := []byte("# ウォリアーズ brief\n116:113")
	var calls int
	var out bytes.Buffer
	if err := copyVoiceLiveFile(chunkedFile(content, 7, []string{"1"}, &calls), &out); err != nil || !bytes.Equal(out.Bytes(), content) || calls < 2 {
		t.Fatalf("copy=%q calls=%d err=%v", out.String(), calls, err)
	}
	calls = 0
	if err := copyVoiceLiveFile(chunkedFile([]byte("0123456789"), 4, []string{"1", "2"}, &calls), io.Discard); err == nil {
		t.Fatal("a file that changed while read was accepted")
	}
}
func TestVoiceLiveMediaTypeIsABareType(t *testing.T) {
	for name, want := range map[string]string{"report.md": "text/markdown", "data.json": "application/json", "slides.pdf": "application/pdf", "blob": "application/octet-stream"} {
		if got := voiceLiveMediaType(name, ""); got != want {
			t.Errorf("%s: %s, want %s", name, got, want)
		}
	}
	if got := voiceLiveMediaType("x.md", "text/markdown; charset=utf-8"); got != "text/markdown" {
		t.Fatalf("stored type=%s", got)
	}
}

// A Document's file is named after its title, keeping the download's
// extension, whatever its stored filename is.
func TestVoiceLiveFileNameFollowsTheTitle(t *testing.T) {
	for _, tc := range []struct{ title, filename, want string }{
		{"Q3 plan", "latest.md", "Q3 plan.md"},
		{"deck.pptx", "deck.pptx", "deck.pptx"},
		{"Deck.PPTX", "upload.pptx", "Deck.PPTX"},
		{"a/b  notes", "latest.md", "a-b notes.md"},
		{" ", "report.pdf", "report.pdf"},
	} {
		if got := voiceLiveFileName(tc.title, tc.filename); got != tc.want {
			t.Errorf("voiceLiveFileName(%q, %q)=%q, want %q", tc.title, tc.filename, got, tc.want)
		}
	}
}
