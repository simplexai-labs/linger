package localtools

import (
	"context"
	"encoding/json"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/permission"
)

type pidStartKey struct {
	pid    int
	lstart string
}

type cachedAppIdentity struct {
	bundleID string
	appName  string
}

var (
	pidAppCacheMu sync.Mutex
	pidAppCache   = map[pidStartKey]cachedAppIdentity{}
)

const maxPIDAppCacheEntries = 512

// lookupPIDStart returns the process start timestamp (`ps -p <pid> -o lstart=`)
// so the PID -> bundle ID cache cannot be poisoned by PID reuse.
var lookupPIDStart = func(ctx context.Context, pid int) (string, error) {
	if runtime.GOOS != "darwin" || pid <= 0 {
		return "", nil
	}
	ctx, cancel := context.WithTimeout(ctx, macLookupTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "/bin/ps", "-p", strconv.Itoa(pid), "-o", "lstart=").Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// lookupPIDAppInfo queries Launch Services for the bundle identifier and
// display name of a running macOS application by PID.
var lookupPIDAppInfo = func(ctx context.Context, pid int) (bundleID, appName string, ok bool) {
	if runtime.GOOS != "darwin" || pid <= 0 {
		return "", "", false
	}
	ctx, cancel := context.WithTimeout(ctx, macLookupTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "/usr/bin/lsappinfo", "info", "-only", "bundleid,name", strconv.Itoa(pid)).Output()
	if err != nil {
		return "", "", false
	}
	bundleID, appName = parseLSAppInfo(string(out))
	return bundleID, appName, bundleID != ""
}

// lookupAppBundleByName resolves an app display name to its macOS bundle ID.
var lookupAppBundleByName = func(ctx context.Context, name string) (bundleID, appName string, ok bool) {
	if runtime.GOOS != "darwin" || strings.TrimSpace(name) == "" {
		return "", "", false
	}
	if pid, err := lsappPID(ctx, name); err == nil && pid > 0 {
		if b, n, found := pidAppIdentity(ctx, pid); found {
			return b, n, true
		}
	}
	path := appPathByName(ctx, name)
	if path == "" {
		return "", "", false
	}
	ctx, cancel := context.WithTimeout(ctx, macLookupTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "/usr/bin/mdls", "-name", "kMDItemCFBundleIdentifier", "-raw", path).Output()
	if err != nil {
		return "", "", false
	}
	bundle := strings.TrimSpace(string(out))
	if bundle == "" || bundle == "(null)" {
		return "", "", false
	}
	return bundle, name, true
}

// parseLSAppInfo extracts CFBundleIdentifier and LSDisplayName from
// `lsappinfo info -only bundleid,name` output.
func parseLSAppInfo(output string) (bundleID, appName string) {
	for line := range strings.SplitSeq(output, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		key, rawVal, found := strings.Cut(line, "=")
		if !found {
			continue
		}
		key = strings.Trim(strings.TrimSpace(key), `"`)
		val := strings.Trim(strings.TrimSpace(rawVal), `"`)
		if val == "" || val == "[ NULL ]" {
			continue
		}
		switch strings.ToLower(key) {
		case "cfbundleidentifier", "bundleid":
			bundleID = val
		case "lsdisplayname", "cfbundlename", "name":
			if appName == "" {
				appName = val
			}
		}
	}
	return bundleID, appName
}

// pidAppIdentity resolves (bundleID, appName) for a macOS PID, caching results
// by (pid, lstart) to prevent stale hits after PID reuse.
func pidAppIdentity(ctx context.Context, pid int) (bundleID, appName string, ok bool) {
	if pid <= 0 {
		return "", "", false
	}
	lstart, err := lookupPIDStart(ctx, pid)
	if err != nil || lstart == "" {
		// Fall back to uncached lookup when ps fails or in non-darwin tests.
		return lookupPIDAppInfo(ctx, pid)
	}
	key := pidStartKey{pid: pid, lstart: lstart}
	pidAppCacheMu.Lock()
	if cached, hit := pidAppCache[key]; hit {
		pidAppCacheMu.Unlock()
		return cached.bundleID, cached.appName, cached.bundleID != ""
	}
	pidAppCacheMu.Unlock()

	bundleID, appName, ok = lookupPIDAppInfo(ctx, pid)
	if !ok || bundleID == "" {
		return "", "", false
	}
	pidAppCacheMu.Lock()
	if len(pidAppCache) >= maxPIDAppCacheEntries {
		pidAppCache = map[pidStartKey]cachedAppIdentity{}
	}
	pidAppCache[key] = cachedAppIdentity{bundleID: bundleID, appName: appName}
	pidAppCacheMu.Unlock()
	return bundleID, appName, true
}

var scriptGetAppLiteral = regexp.MustCompile(`getApp\s*\(\s*["']([^"']+)["']\s*\)`)

// resolveAppTarget identifies the macOS application (BundleID, App) targeted by
// a computer tool call. It covers launch_app, pid, element_token, run_actions,
// and run_script.
func (op *operation) resolveAppTarget(ctx context.Context, tool string, args json.RawMessage) *permission.Desktop {
	if op == nil {
		return nil
	}
	var payload map[string]any
	if json.Unmarshal(args, &payload) != nil || payload == nil {
		return nil
	}
	switch tool {
	case "launch_app":
		bundle, _ := payload["bundle_id"].(string)
		name, _ := payload["name"].(string)
		bundle = strings.TrimSpace(bundle)
		name = strings.TrimSpace(name)
		if bundle != "" {
			if name == "" {
				if pid, err := lsappPID(ctx, bundle); err == nil && pid > 0 {
					if _, resolvedName, ok := pidAppIdentity(ctx, pid); ok && resolvedName != "" {
						name = resolvedName
					}
				}
			}
			return &permission.Desktop{BundleID: bundle, App: name}
		}
		if name != "" {
			if resolvedBundle, resolvedName, ok := lookupAppBundleByName(ctx, name); ok {
				if resolvedName == "" {
					resolvedName = name
				}
				return &permission.Desktop{BundleID: resolvedBundle, App: resolvedName}
			}
		}
		return nil
	case "run_actions":
		actions, _ := payload["actions"].([]any)
		var fallback *permission.Desktop
		approved := op.approvedComputerAppSet()
		for _, item := range actions {
			step, ok := item.(map[string]any)
			if !ok {
				continue
			}
			target := op.resolveStepAppTarget(ctx, step)
			if target == nil || target.BundleID == "" {
				continue
			}
			if permission.IsProtectedMacApp(target.BundleID) {
				return target
			}
			if len(approved) > 0 && !approved[strings.ToLower(target.BundleID)] {
				return target
			}
			if fallback == nil {
				fallback = target
			}
		}
		return fallback
	case "run_script":
		if scriptArgs, ok := payload["args"].(map[string]any); ok {
			if target := op.resolveStepAppTarget(ctx, scriptArgs); target != nil {
				return target
			}
			if bundle, _ := scriptArgs["bundle_id"].(string); strings.TrimSpace(bundle) != "" {
				appName, _ := scriptArgs["app"].(string)
				return &permission.Desktop{BundleID: strings.TrimSpace(bundle), App: strings.TrimSpace(appName)}
			}
			if appName, _ := scriptArgs["app"].(string); strings.TrimSpace(appName) != "" {
				if bundle, resolvedName, ok := lookupAppBundleByName(ctx, strings.TrimSpace(appName)); ok {
					return &permission.Desktop{BundleID: bundle, App: resolvedName}
				}
			}
		}
		if scriptBody, _ := payload["script"].(string); scriptBody != "" {
			if match := scriptGetAppLiteral.FindStringSubmatch(scriptBody); len(match) == 2 {
				appRef := strings.TrimSpace(match[1])
				if strings.Contains(appRef, ".") {
					return &permission.Desktop{BundleID: appRef}
				}
				if bundle, resolvedName, ok := lookupAppBundleByName(ctx, appRef); ok {
					return &permission.Desktop{BundleID: bundle, App: resolvedName}
				}
			}
		}
		return nil
	default:
		return op.resolveStepAppTarget(ctx, payload)
	}
}

func (op *operation) resolveStepAppTarget(ctx context.Context, step map[string]any) *permission.Desktop {
	if step == nil {
		return nil
	}
	pid := 0
	if rawPID, ok := step["pid"].(float64); ok && rawPID > 0 {
		pid = int(rawPID)
	}
	if pid == 0 {
		if token, ok := step["element_token"].(string); ok && token != "" {
			if key, found := op.reads.window(token); found && key.pid > 0 {
				pid = int(key.pid)
			}
		}
	}
	if pid <= 0 {
		return nil
	}
	bundleID, appName, ok := pidAppIdentity(ctx, pid)
	if !ok || bundleID == "" {
		return nil
	}
	return &permission.Desktop{BundleID: bundleID, App: appName}
}

func (op *operation) approvedComputerAppSet() map[string]bool {
	if op == nil || op.set == nil {
		return nil
	}
	list := op.set.ApprovedComputerApps()
	if len(list) == 0 {
		return nil
	}
	set := make(map[string]bool, len(list))
	for _, b := range list {
		set[strings.ToLower(strings.TrimSpace(b))] = true
	}
	return set
}

// scriptAppAllowlist bounds which running macOS PIDs and bundle identifiers a
// run_script body may target via cua.getApp or cua.call.
type scriptAppAllowlist struct {
	PIDs    []int
	Bundles []string
}

func (op *operation) buildScriptAppAllowlist(ctx context.Context) *scriptAppAllowlist {
	if op == nil || runtime.GOOS != "darwin" || !op.spec.ReviewsPermissions() {
		return nil
	}
	var bundles []string
	if op.set != nil {
		bundles = op.set.ApprovedComputerApps()
	}
	allow := &scriptAppAllowlist{Bundles: make([]string, 0, len(bundles))}
	seenPID := map[int]bool{}
	for _, bundle := range bundles {
		b := strings.TrimSpace(bundle)
		if b == "" {
			continue
		}
		allow.Bundles = append(allow.Bundles, strings.ToLower(b))
		if pid, err := lsappPID(ctx, b); err == nil && pid > 0 && !seenPID[pid] {
			seenPID[pid] = true
			allow.PIDs = append(allow.PIDs, pid)
		}
	}
	return allow
}
