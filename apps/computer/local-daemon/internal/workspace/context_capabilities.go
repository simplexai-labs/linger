package workspace

import (
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
)

// ConfigureClaudeContextHome prepares the isolated Claude configuration the
// Runtime runs under and returns the names of the Computer's own Skills that
// the Context inherits.
//
// Two setting sources carry Skills, and each carries exactly one kind. The
// project source is the Context workspace, where `.claude/skills` points at the
// authorized Skill Snapshot. The user source is this isolated configuration
// directory, which holds links to the Computer's own Skills. Keeping them apart
// is what lets inherited Skills stay on the Computer: the workspace refuses a
// link that leaves it, and the Snapshot projection refuses a link at all.
func ConfigureClaudeContextHome(home, workspace string, environment map[string]string, retireResident func() error) ([]string, error) {
	configRoot := filepath.Join(home, ".claude")
	if err := privatefs.EnsureDir(configRoot); err != nil {
		return nil, err
	}
	// Read the Computer's own configuration directory before seeding, which
	// repoints CLAUDE_CONFIG_DIR at the isolated one.
	configHome := ClaudeSourceHome(environment)
	if err := configureClaudeCredentials(configRoot, environment, retireResident); err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(workspace)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	if err := root.MkdirAll(".agents/skills", 0o700); err != nil {
		return nil, err
	}
	if err := root.MkdirAll(".claude", 0o700); err != nil {
		return nil, err
	}
	if err := ensureClaudeProjectSkills(root); err != nil {
		return nil, err
	}
	return SyncClaudeSkills(configRoot, configHome, filepath.Join(workspace, ".agents", "skills"))
}

// ClaudeSourceHome resolves the Computer user's own Claude configuration
// directory from the Runtime environment, before any isolation is applied.
func ClaudeSourceHome(environment map[string]string) string {
	if value := strings.TrimSpace(environment["CLAUDE_CONFIG_DIR"]); value != "" {
		return value
	}
	if home := strings.TrimSpace(environment["HOME"]); home != "" {
		return filepath.Join(home, ".claude")
	}
	return ""
}

func writePrivateRuntimeFile(path string, content []byte) error {
	if err := privatefs.EnsureDir(filepath.Dir(path)); err != nil {
		return err
	}
	if err := privatefs.ProtectFile(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return privatefs.WriteFile(path, content, false)
}
