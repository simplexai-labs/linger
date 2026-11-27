// Package workspace manages owner- and Context-scoped Runtime homes and
// temporary execution directories.
package workspace

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
)

const (
	antigravitySeedFileLimit  = 4 << 20
	antigravityAuthSourceFile = ".linger-auth-source.sha256"
	antigravityOAuthTokenFile = "antigravity-oauth-token" //nolint:gosec // filename constant, not a credential
	antigravitySettingsFile   = "settings.json"
)

var antigravitySeedFiles = []string{
	antigravityOAuthTokenFile,
	antigravitySettingsFile,
}

// AntigravityGeminiDir returns the isolated Gemini directory passed to
// `agy acp --gemini-dir` inside a Context's Runtime home.
func AntigravityGeminiDir(runtimeHome string) string {
	return filepath.Join(runtimeHome, "gemini")
}

// AntigravityAppDataDir returns the Antigravity application data directory
// inside a Context's Runtime home.
func AntigravityAppDataDir(runtimeHome string) string {
	return filepath.Join(runtimeHome, "gemini", "antigravity-cli")
}

// AntigravityACPLogPath returns the ACP server log file path passed to
// `agy acp --log-file` inside a Context's Runtime home.
func AntigravityACPLogPath(runtimeHome string) string {
	return filepath.Join(runtimeHome, "acp.log")
}

// PrepareAntigravityRuntimeHome claims an owner- and Context-scoped Runtime
// home for Antigravity, ensures its private directory layout without following
// symlinks, and reconciles the user's seed files into the isolated app data
// directory. It preserves in-home OAuth token refreshes while the user's source
// token digest stays unchanged, and calls retireResident at most once before
// mutating any file under the isolated app data directory.
func PrepareAntigravityRuntimeHome(
	ctx context.Context,
	root string,
	environment map[string]string,
	identity RuntimeHomeIdentity,
	retireResident func(home string) error,
) (*RuntimeHome, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if identity.ProviderType != "antigravity" {
		return nil, errors.New("Antigravity Runtime home identity is invalid")
	}
	home, err := claimRuntimeHome(root, identity)
	if err != nil {
		return nil, err
	}
	keep := false
	defer func() {
		if !keep {
			_ = home.Close()
		}
	}()

	geminiDir := AntigravityGeminiDir(home.Path)
	appDataDir := AntigravityAppDataDir(home.Path)
	for _, dir := range []string{home.Path, geminiDir, appDataDir} {
		if err := privatefs.EnsureDir(dir); err != nil {
			return nil, err
		}
	}

	homeRoot, err := openProjectionRoot(home.Path)
	if err != nil {
		return nil, err
	}
	defer homeRoot.Close()

	appDataRel := filepath.Join("gemini", "antigravity-cli")
	for _, rel := range []string{"gemini", appDataRel} {
		if err := localProjectionDirectory(homeRoot, rel); err != nil {
			return nil, err
		}
	}

	if logInfo, logErr := homeRoot.Lstat("acp.log"); logErr == nil {
		if !logInfo.Mode().IsRegular() {
			return nil, errors.New("Antigravity ACP log path must be a regular file")
		}
	} else if !errors.Is(logErr, os.ErrNotExist) {
		return nil, logErr
	}

	sourceDir := AntigravityUserAppDataDir(environment)
	if sourceDir != "" {
		if sourceInfo, statErr := os.Stat(sourceDir); statErr == nil {
			targetInfo, targetErr := homeRoot.Stat(appDataRel)
			if targetErr != nil {
				return nil, targetErr
			}
			if os.SameFile(sourceInfo, targetInfo) {
				return nil, errors.New("Antigravity source resolves to the Runtime home")
			}
		}
	}

	tokenSource, err := readAntigravitySeedFile(sourceDir, antigravityOAuthTokenFile)
	if err != nil {
		return nil, err
	}
	settingsSource, err := readAntigravitySeedFile(sourceDir, antigravitySettingsFile)
	if err != nil {
		return nil, err
	}

	retired := false
	retireOnce := func() error {
		if retired || retireResident == nil {
			return nil
		}
		if err := retireResident(home.Path); err != nil {
			return err
		}
		retired = true
		return nil
	}

	if err := reconcileAntigravityToken(homeRoot, appDataRel, tokenSource, retireOnce); err != nil {
		return nil, err
	}
	if err := reconcileAntigravitySettings(homeRoot, appDataRel, settingsSource, retireOnce); err != nil {
		return nil, err
	}

	if err := ctx.Err(); err != nil {
		return nil, err
	}
	keep = true
	return home, nil
}

// AntigravityUserAppDataDir returns the user's Antigravity application data
// directory derived from HOME or USERPROFILE in environment, or empty when
// neither variable is set.
func AntigravityUserAppDataDir(environment map[string]string) string {
	userHome := EnvLookup(environment, "HOME")
	if userHome == "" {
		userHome = EnvLookup(environment, "USERPROFILE")
	}
	if userHome == "" {
		return ""
	}
	return filepath.Join(userHome, ".gemini", "antigravity-cli")
}

// SeedAntigravityAppDataDir ensures appDataDir exists privately and copies any
// present Antigravity seed files from the user's application data directory
// without modifying the user's directory.
func SeedAntigravityAppDataDir(appDataDir string, environment map[string]string) error {
	if err := privatefs.EnsureDir(appDataDir); err != nil {
		return err
	}
	sourceDir := AntigravityUserAppDataDir(environment)
	if sourceDir == "" {
		return nil
	}
	if sourceInfo, statErr := os.Stat(sourceDir); statErr == nil {
		if targetInfo, targetErr := os.Stat(appDataDir); targetErr == nil && os.SameFile(sourceInfo, targetInfo) {
			return errors.New("Antigravity source resolves to the target app data directory")
		}
	}
	for _, name := range antigravitySeedFiles {
		data, err := readAntigravitySeedFile(sourceDir, name)
		if err != nil {
			return err
		}
		if data == nil {
			continue
		}
		if err := privatefs.WriteFile(filepath.Join(appDataDir, name), data, true); err != nil {
			return err
		}
	}
	return nil
}

// AntigravityAuthFingerprint hashes the presence and content of the user's
// Antigravity credential and settings seed files without exposing file
// contents.
func AntigravityAuthFingerprint(environment map[string]string) string {
	sourceDir := AntigravityUserAppDataDir(environment)
	if sourceDir == "" {
		return ""
	}
	sum := sha256.New()
	for _, name := range antigravitySeedFiles {
		data, err := readAntigravitySeedFile(sourceDir, name)
		switch {
		case err != nil:
			_, _ = fmt.Fprintf(sum, "%s\x00error\n", name)
		case data == nil:
			_, _ = fmt.Fprintf(sum, "%s\x00absent\n", name)
		default:
			_, _ = fmt.Fprintf(sum, "%s\x00present\x00%d:", name, len(data))
			_, _ = sum.Write(data)
			_, _ = sum.Write([]byte{'\n'})
		}
	}
	return hex.EncodeToString(sum.Sum(nil))
}

func readAntigravitySeedFile(sourceDir, name string) ([]byte, error) {
	if sourceDir == "" {
		return nil, nil
	}
	path := filepath.Join(sourceDir, name)
	statInfo, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("stat Antigravity seed file %s: %w", name, err)
	}
	if !statInfo.Mode().IsRegular() {
		return nil, fmt.Errorf("Antigravity seed file %s must be a regular file", name)
	}
	if statInfo.Size() > antigravitySeedFileLimit {
		return nil, fmt.Errorf("Antigravity seed file %s exceeds 4 MiB", name)
	}
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read Antigravity seed file %s: %w", name, err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("Antigravity seed file %s must be a regular file", name)
	}
	data, err := io.ReadAll(io.LimitReader(file, antigravitySeedFileLimit+1))
	if err != nil {
		return nil, err
	}
	if len(data) > antigravitySeedFileLimit {
		return nil, fmt.Errorf("Antigravity seed file %s exceeds 4 MiB", name)
	}
	if data == nil {
		data = []byte{}
	}
	return data, nil
}

func antigravityAuthSourceDigest(source []byte) string {
	sum := sha256.New()
	if source == nil {
		_, _ = sum.Write([]byte("absent\x00"))
	} else {
		_, _ = sum.Write([]byte("present\x00"))
		_, _ = sum.Write(source)
	}
	return hex.EncodeToString(sum.Sum(nil))
}

func reconcileAntigravityToken(homeRoot *os.Root, appDataRel string, source []byte, retireOnce func() error) error {
	tokenRel := filepath.Join(appDataRel, antigravityOAuthTokenFile)
	markerRel := filepath.Join(appDataRel, antigravityAuthSourceFile)
	sourceDigest := antigravityAuthSourceDigest(source)

	var previousMarker string
	if markerInfo, err := homeRoot.Lstat(markerRel); err == nil {
		if markerInfo.Mode().IsRegular() && markerInfo.Size() <= 256 {
			if data, readErr := homeRoot.ReadFile(markerRel); readErr == nil {
				previousMarker = strings.TrimSpace(string(data))
			}
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}

	destInfo, destErr := homeRoot.Lstat(tokenRel)
	destExists := false
	if destErr == nil {
		destExists = true
	} else if !errors.Is(destErr, os.ErrNotExist) {
		return destErr
	}

	if source == nil {
		if !destExists && previousMarker == sourceDigest {
			return nil
		}
		if destExists {
			if err := retireOnce(); err != nil {
				return err
			}
			if err := removeProjectionFile(homeRoot, tokenRel); err != nil {
				return err
			}
		}
		if previousMarker != sourceDigest {
			if err := replaceProjectionFile(homeRoot, markerRel, []byte(sourceDigest)); err != nil {
				return err
			}
		}
		return nil
	}

	// Keep the isolated token untouched when the user source digest matches so
	// native OAuth refreshes survive and parked residents stay warm.
	if previousMarker == sourceDigest && destExists && destInfo.Mode().IsRegular() && (destInfo.Size() > 0 || len(source) == 0) {
		return nil
	}
	if err := retireOnce(); err != nil {
		return err
	}
	if err := replaceProjectionFile(homeRoot, tokenRel, source); err != nil {
		return err
	}
	return replaceProjectionFile(homeRoot, markerRel, []byte(sourceDigest))
}

func reconcileAntigravitySettings(homeRoot *os.Root, appDataRel string, source []byte, retireOnce func() error) error {
	settingsRel := filepath.Join(appDataRel, antigravitySettingsFile)
	destInfo, destErr := homeRoot.Lstat(settingsRel)
	destExists := false
	if destErr == nil {
		destExists = true
	} else if !errors.Is(destErr, os.ErrNotExist) {
		return destErr
	}

	if source == nil {
		if !destExists {
			return nil
		}
		if err := retireOnce(); err != nil {
			return err
		}
		return removeProjectionFile(homeRoot, settingsRel)
	}

	if destExists && destInfo.Mode().IsRegular() && destInfo.Size() == int64(len(source)) {
		if existing, err := homeRoot.ReadFile(settingsRel); err == nil && bytes.Equal(existing, source) {
			return nil
		}
	}
	if err := retireOnce(); err != nil {
		return err
	}
	return replaceProjectionFile(homeRoot, settingsRel, source)
}
