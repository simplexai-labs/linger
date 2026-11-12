package voicelive

import (
	"strings"
	"testing"
	"time"
)

func TestParsePlaygroundPathKeepsInsideItsFolder(t *testing.T) {
	for raw, want := range map[string]PlaygroundPath{
		"":                                     {},
		"./playground/":                        {},
		"playground":                           {},
		"./playground/workitem_1/":             {Folder: "workitem_1"},
		"./playground/workitem_1/out/a.png":    {Folder: "workitem_1", Inside: "out/a.png"},
		"playground/room_1/notes.md":           {Folder: "room_1", Inside: "notes.md"},
		"./playground/workitem_1/./out//a.png": {Folder: "workitem_1", Inside: "out/a.png"},
	} {
		if got, ok := ParsePlaygroundPath(raw); !ok || got != want {
			t.Errorf("ParsePlaygroundPath(%q)=%+v %v, want %+v", raw, got, ok, want)
		}
	}
	for _, raw := range []string{"/etc/passwd", "./playground/workitem_1/../room_1/a", "../playground/x", "./other/a", "./playground/w\\a", "./playground/w/a\x00"} {
		if got, ok := ParsePlaygroundPath(raw); ok {
			t.Errorf("ParsePlaygroundPath(%q) accepted as %+v", raw, got)
		}
	}
}

func TestFormatListingReadsLikeLs(t *testing.T) {
	modified := time.Date(2026, 11, 11, 10, 10, 2, 0, time.FixedZone("CST", 8*3600))
	listing := FormatListing("./playground/workitem_1/", []ListEntry{
		{Name: "out", Directory: true, Modified: modified},
		{Name: "cartoon.png", Size: 201_728, Modified: modified},
	}, 3)
	for _, want := range []string{"./playground/workitem_1/\n", "    -  2026-11-11 02:10Z  out/\n", " 197K  2026-11-11 02:10Z  cartoon.png\n", "… 1 more\n"} {
		if !strings.Contains(listing, want) {
			t.Fatalf("listing %q lacks %q", listing, want)
		}
	}
	if got := FormatListing("./playground/", nil, 0); got != "./playground/\n(empty)\n" {
		t.Fatalf("empty listing=%q", got)
	}
}

func TestHumanSize(t *testing.T) {
	for size, want := range map[int64]string{0: "0", 512: "512", 3800: "3.7K", 201_728: "197K", 12 << 20: "12M"} {
		if got := HumanSize(size); got != want {
			t.Errorf("HumanSize(%d)=%s, want %s", size, got, want)
		}
	}
}
