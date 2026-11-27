package computercli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Without Chrome, doctor reports the browser tools working in Edge, and
// warns only when neither browser is installed.
func TestDoctorBrowserCheckAcceptsEdgeWithoutChrome(t *testing.T) {
	root := t.TempDir()
	environment := map[string]string{"PROGRAMFILES": root}
	if check := inspectBrowserMode(t.TempDir(), environment, "windows"); check.Status != "warn" {
		t.Fatalf("no browser: %+v", check)
	}
	edge := filepath.Join(root, "Microsoft", "Edge", "Application", "msedge.exe")
	if err := os.MkdirAll(filepath.Dir(edge), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(edge, nil, 0o700); err != nil {
		t.Fatal(err)
	}
	if check := inspectBrowserMode(t.TempDir(), environment, "windows"); check.Status != "pass" || !strings.Contains(check.Detail, "Microsoft Edge") {
		t.Fatalf("Edge only: %+v", check)
	}
}
