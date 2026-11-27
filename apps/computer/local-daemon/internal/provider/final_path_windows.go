//go:build windows

package provider

import "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/finalpath"

func resolveFinalPath(path string) (string, error) {
	return finalpath.Resolve(path)
}
