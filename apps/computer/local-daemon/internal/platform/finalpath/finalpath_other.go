//go:build !windows

// Package finalpath resolves canonical filesystem paths, following Windows
// directory junctions in addition to symbolic links.
package finalpath

import "path/filepath"

// Resolve returns the canonical path of path after following symbolic links
// and Windows directory junctions.
func Resolve(path string) (string, error) {
	return filepath.EvalSymlinks(path)
}
