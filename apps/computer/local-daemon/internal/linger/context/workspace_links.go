package lingercontext

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// validateWorkspaceLinks keeps the projection boundary: a managed read-only
// mapping never contains a symbolic link. Playground and other writable
// trees are agent scratch; host links there are Trusted Host content, not a
// Context failure. Export still refuses to publish a path that contains a
// symlink. Dangling or cyclic links in writable trees are repository
// content and are left in place.
func validateWorkspaceLinks(workspace string, mappings []Mapping) error {
	info, err := os.Lstat(workspace)
	if err != nil {
		return err
	}
	if !realDirectory(info) {
		return errors.New("Context Workspace is not a real directory")
	}
	canonical, err := filepath.EvalSymlinks(workspace)
	if err != nil {
		return err
	}
	seen := map[string]struct{}{}
	for _, mapping := range mappings {
		if mapping.Access != "read_only" || mapping.TargetPath == "" {
			continue
		}
		root := filepath.Join(canonical, filepath.Clean(mapping.TargetPath))
		if root != canonical && !strings.HasPrefix(root, canonical+string(filepath.Separator)) {
			return errors.New("Context read-only projection path is outside the Workspace")
		}
		if _, ok := seen[root]; ok {
			continue
		}
		seen[root] = struct{}{}
		if err := rejectReadOnlyParentLinks(canonical, filepath.Clean(mapping.TargetPath)); err != nil {
			return err
		}
		if err := rejectReadOnlyProjectionLinks(root); err != nil {
			return err
		}
	}
	return nil
}

func rejectReadOnlyParentLinks(canonical, target string) error {
	parent := filepath.Dir(target)
	if parent == "." || parent == "" {
		return nil
	}
	current := canonical
	for _, component := range strings.Split(parent, string(filepath.Separator)) {
		if component == "." || component == "" {
			continue
		}
		current = filepath.Join(current, component)
		info, err := os.Lstat(current)
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if directoryLink(info) {
			return errors.New("Context read-only projection contains a symbolic link")
		}
	}
	return nil
}

func rejectReadOnlyProjectionLinks(root string) error {
	info, err := os.Lstat(root)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if directoryLink(info) {
		return errors.New("Context read-only projection contains a symbolic link")
	}
	if !info.IsDir() {
		return nil
	}
	return filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&(os.ModeSymlink|os.ModeIrregular) != 0 {
			return errors.New("Context read-only projection contains a symbolic link")
		}
		return nil
	})
}
