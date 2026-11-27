package finalpath

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveReturnsCanonicalDirectory(t *testing.T) {
	root := t.TempDir()
	nested := filepath.Join(root, "sub")
	if err := os.MkdirAll(nested, 0o700); err != nil {
		t.Fatal(err)
	}
	got, err := Resolve(nested)
	if err != nil {
		t.Fatalf("Resolve(%q): %v", nested, err)
	}
	want, err := filepath.EvalSymlinks(nested)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("Resolve(%q) = %q, want %q", nested, got, want)
	}
}
