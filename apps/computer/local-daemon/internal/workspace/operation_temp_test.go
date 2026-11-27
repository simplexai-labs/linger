package workspace

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
)

func TestOperationTempLeasesKeepSweepLockUntilLastRelease(t *testing.T) {
	base := t.TempDir()
	temp, err := PrepareOperationTemp(base)
	if err != nil {
		t.Fatal(err)
	}
	defer temp.Close()
	first, err := temp.Retain()
	if err != nil {
		t.Fatal(err)
	}
	defer first()
	last, err := temp.Retain()
	if err != nil {
		t.Fatal(err)
	}
	defer last()
	for _, close := range []func() error{temp.Close, temp.Close, first, first} {
		if err := close(); err != nil {
			t.Fatal(err)
		}
	}
	if count, _, err := PruneOperationTemps(base, nil); err != nil || count != 0 {
		t.Fatalf("sweep removed a retained directory: %d, %v", count, err)
	}
	if err := os.WriteFile(temp.Path+"/still-owned", []byte("alive"), 0o600); err != nil {
		t.Fatalf("the last lease lost its temp directory: %v", err)
	}
	if err := last(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(temp.Path); !os.IsNotExist(err) {
		t.Fatalf("last release left the directory: %v", err)
	}
	if _, err := temp.Retain(); err == nil {
		t.Fatal("a released directory acquired a new lease")
	}
}

func TestPrepareOperationTempProtectsBaseAndDirectoryWithPrivateFS(t *testing.T) {
	root := t.TempDir()
	base := filepath.Join(root, "operation-tmp")
	if err := os.MkdirAll(base, 0o755); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(base, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	temp, err := PrepareOperationTemp(base)
	if err != nil {
		t.Fatalf("PrepareOperationTemp(%q): %v", base, err)
	}
	defer func() {
		if err := temp.Close(); err != nil {
			t.Fatalf("Close(): %v", err)
		}
	}()

	if err := privatefs.CheckPath(base, "directory", true); err != nil {
		t.Fatalf("base failed privatefs check: %v", err)
	}
	if err := privatefs.CheckPath(temp.Path, "directory", true); err != nil {
		t.Fatalf("operation temp dir failed privatefs check: %v", err)
	}

	fileBase := filepath.Join(root, "not-a-directory")
	if err := os.WriteFile(fileBase, []byte("file"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := PrepareOperationTemp(fileBase); err == nil {
		t.Fatal("PrepareOperationTemp succeeded on a regular file base")
	}
}
