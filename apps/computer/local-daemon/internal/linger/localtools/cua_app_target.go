package localtools

import (
	"context"
	"encoding/json"
	"fmt"
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

// lookupBundleInstances resolves every running PID and display name matching
// bundleID on macOS so multi-instance apps (such as Chrome profiles) and
// name-based `cua.getApp("Google Chrome")` calls are covered.
var lookupBundleInstances = func(ctx context.Context, bundleID string) (pids []int, names []string) {
	if runtime.GOOS != "darwin" || strings.TrimSpace(bundleID) == "" {
		return nil, nil
	}
	seenPID := map[int]bool{}
	seenName := map[string]bool{}
	add := func(pid int, name string) {
		if pid > 0 && !seenPID[pid] {
			seenPID[pid] = true
			pids = append(pids, pid)
		}
		name = strings.TrimSpace(name)
		if name != "" && !seenName[strings.ToLower(name)] {
			seenName[strings.ToLower(name)] = true
			names = append(names, name)
		}
	}
	findCtx, cancel := context.WithTimeout(ctx, macLookupTimeout)
	found, err := exec.CommandContext(findCtx, "/usr/bin/lsappinfo", "find", "bundleid="+bundleID).Output()
	cancel()
	if err == nil {
		for field := range strings.FieldsSeq(string(found)) {
			if !strings.HasPrefix(field, "ASN:") {
				continue
			}
			asn := strings.TrimSuffix(field, ":")
			infoCtx, infoCancel := context.WithTimeout(ctx, macLookupTimeout)
			out, infoErr := exec.CommandContext(infoCtx, "/usr/bin/lsappinfo", "info", "-only", "pid,name", asn).Output()
			infoCancel()
			if infoErr != nil {
				continue
			}
			pid, name := parseLSAppPIDAndName(string(out))
			add(pid, name)
		}
	}
	if len(pids) == 0 {
		if pid, err := lsappPID(ctx, bundleID); err == nil && pid > 0 {
			_, name, _ := pidAppIdentity(ctx, pid)
			add(pid, name)
		}
	}
	return pids, names
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

func parseLSAppPIDAndName(output string) (pid int, appName string) {
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
		case "pid":
			if parsed, err := strconv.Atoi(val); err == nil && parsed > 0 {
				pid = parsed
			}
		case "lsdisplayname", "cfbundlename", "name":
			if appName == "" {
				appName = val
			}
		}
	}
	return pid, appName
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
// and run_script, failing closed on mixed-app batches or unresolved steps.
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
		return op.resolveRunActionsTarget(ctx, payload)
	case "run_script":
		return op.resolveRunScriptTarget(ctx, payload)
	default:
		return op.resolveStepAppTarget(ctx, payload)
	}
}

func (op *operation) resolveRunActionsTarget(ctx context.Context, payload map[string]any) *permission.Desktop {
	actions, _ := payload["actions"].([]any)
	approved := op.approvedComputerAppSet()
	var (
		firstApproved   *permission.Desktop
		unapprovedOrder []*permission.Desktop
		unapprovedByID  = map[string]bool{}
		resolvedCount   int
		unresolvedCount int
	)
	inspect := func(step map[string]any) *permission.Desktop {
		target := op.resolveStepAppTarget(ctx, step)
		if target == nil || strings.TrimSpace(target.BundleID) == "" {
			unresolvedCount++
			return nil
		}
		resolvedCount++
		if permission.IsProtectedMacApp(target.BundleID) {
			return target
		}
		lower := strings.ToLower(strings.TrimSpace(target.BundleID))
		if approved[lower] {
			if firstApproved == nil {
				firstApproved = target
			}
			return nil
		}
		if !unapprovedByID[lower] {
			unapprovedByID[lower] = true
			unapprovedOrder = append(unapprovedOrder, target)
		}
		return nil
	}
	for _, item := range actions {
		step, ok := item.(map[string]any)
		if !ok {
			unresolvedCount++
			continue
		}
		if protected := inspect(step); protected != nil {
			return protected
		}
	}
	if readStep, ok := payload["read"].(map[string]any); ok && len(readStep) > 0 {
		if _, hasPID := readStep["pid"]; hasPID {
			if protected := inspect(readStep); protected != nil {
				return protected
			}
		} else if _, hasToken := readStep["element_token"]; hasToken {
			if protected := inspect(readStep); protected != nil {
				return protected
			}
		}
	}
	if unresolvedCount > 0 {
		if resolvedCount > 0 {
			return &permission.Desktop{
				DenyReason: "COMPUTER_TARGET_REQUIRED: every step in run_actions must target an identifiable macOS app (include pid or element_token). Split unresolved steps out of the batch.",
			}
		}
		return nil
	}
	if len(unapprovedOrder) > 1 {
		labels := make([]string, 0, len(unapprovedOrder))
		for _, target := range unapprovedOrder {
			if target.App != "" {
				labels = append(labels, fmt.Sprintf("%s (%s)", target.App, target.BundleID))
			} else {
				labels = append(labels, target.BundleID)
			}
		}
		return &permission.Desktop{
			DenyReason: fmt.Sprintf("COMPUTER_MULTI_APP_BATCH: run_actions targets multiple unapproved apps (%s). Batch actions for one app at a time so each app can be approved separately.", strings.Join(labels, ", ")),
		}
	}
	if len(unapprovedOrder) == 1 {
		return unapprovedOrder[0]
	}
	return firstApproved
}

func (op *operation) resolveRunScriptTarget(ctx context.Context, payload map[string]any) *permission.Desktop {
	approved := op.approvedComputerAppSet()
	var (
		firstApproved   *permission.Desktop
		unapprovedOrder []*permission.Desktop
		unapprovedByID  = map[string]bool{}
	)
	record := func(target *permission.Desktop) *permission.Desktop {
		if target == nil || strings.TrimSpace(target.BundleID) == "" {
			return nil
		}
		if permission.IsProtectedMacApp(target.BundleID) {
			return target
		}
		lower := strings.ToLower(strings.TrimSpace(target.BundleID))
		if approved[lower] {
			if firstApproved == nil {
				firstApproved = target
			}
			return nil
		}
		if !unapprovedByID[lower] {
			unapprovedByID[lower] = true
			unapprovedOrder = append(unapprovedOrder, target)
		}
		return nil
	}

	if scriptArgs, ok := payload["args"].(map[string]any); ok {
		if protected := record(op.resolveStepAppTarget(ctx, scriptArgs)); protected != nil {
			return protected
		}
		if bundle, _ := scriptArgs["bundle_id"].(string); strings.TrimSpace(bundle) != "" {
			appName, _ := scriptArgs["app"].(string)
			if protected := record(&permission.Desktop{BundleID: strings.TrimSpace(bundle), App: strings.TrimSpace(appName)}); protected != nil {
				return protected
			}
		}
		if appName, _ := scriptArgs["app"].(string); strings.TrimSpace(appName) != "" {
			if bundle, resolvedName, ok := lookupAppBundleByName(ctx, strings.TrimSpace(appName)); ok {
				if protected := record(&permission.Desktop{BundleID: bundle, App: resolvedName}); protected != nil {
					return protected
				}
			}
		}
	}
	if scriptBody, _ := payload["script"].(string); scriptBody != "" {
		for _, match := range scriptGetAppLiteral.FindAllStringSubmatch(scriptBody, -1) {
			if len(match) != 2 {
				continue
			}
			appRef := strings.TrimSpace(match[1])
			var target *permission.Desktop
			if strings.Contains(appRef, ".") {
				target = &permission.Desktop{BundleID: appRef}
			} else if bundle, resolvedName, ok := lookupAppBundleByName(ctx, appRef); ok {
				target = &permission.Desktop{BundleID: bundle, App: resolvedName}
			}
			if protected := record(target); protected != nil {
				return protected
			}
		}
	}
	if len(unapprovedOrder) > 1 {
		labels := make([]string, 0, len(unapprovedOrder))
		for _, target := range unapprovedOrder {
			if target.App != "" {
				labels = append(labels, fmt.Sprintf("%s (%s)", target.App, target.BundleID))
			} else {
				labels = append(labels, target.BundleID)
			}
		}
		return &permission.Desktop{
			DenyReason: fmt.Sprintf("COMPUTER_MULTI_APP_SCRIPT: run_script references multiple unapproved apps (%s). Target one app at a time or approve each app first.", strings.Join(labels, ", ")),
		}
	}
	if len(unapprovedOrder) == 1 {
		return unapprovedOrder[0]
	}
	if firstApproved != nil {
		return firstApproved
	}
	// Do not allow a targetless script to run with an empty allowlist that
	// would fail every cua.getApp/cua.call inside the script body.
	if len(approved) == 0 {
		return &permission.Desktop{
			DenyReason: "COMPUTER_TARGET_REQUIRED: specify target app in run_script args (pid or bundle_id) or approve an app first so the script can run.",
		}
	}
	return nil
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

// scriptAppAllowlist bounds which running macOS PIDs, bundle identifiers, and
// app display names a run_script body may target via cua.getApp, cua.call, or
// app method reroutes.
type scriptAppAllowlist struct {
	PIDs    []int
	Bundles []string
	Names   []string
}

func (op *operation) buildScriptAppAllowlist(ctx context.Context, args json.RawMessage) *scriptAppAllowlist {
	if op == nil || runtime.GOOS != "darwin" || !op.spec.ReviewsPermissions() {
		return nil
	}
	seenBundle := map[string]bool{}
	seenPID := map[int]bool{}
	seenName := map[string]bool{}
	allow := &scriptAppAllowlist{}

	addBundle := func(bundle, displayName string) {
		b := strings.TrimSpace(bundle)
		if b == "" || permission.IsProtectedMacApp(b) {
			return
		}
		lower := strings.ToLower(b)
		if !seenBundle[lower] {
			seenBundle[lower] = true
			allow.Bundles = append(allow.Bundles, lower)
		}
		if name := strings.TrimSpace(displayName); name != "" && !seenName[strings.ToLower(name)] {
			seenName[strings.ToLower(name)] = true
			allow.Names = append(allow.Names, strings.ToLower(name))
		}
		pids, names := lookupBundleInstances(ctx, b)
		for _, pid := range pids {
			if pid > 0 && !seenPID[pid] {
				seenPID[pid] = true
				allow.PIDs = append(allow.PIDs, pid)
			}
		}
		for _, name := range names {
			lowerName := strings.ToLower(strings.TrimSpace(name))
			if lowerName != "" && !seenName[lowerName] {
				seenName[lowerName] = true
				allow.Names = append(allow.Names, lowerName)
			}
		}
	}

	if op.set != nil {
		for _, bundle := range op.set.ApprovedComputerApps() {
			addBundle(bundle, "")
		}
	}
	// If this exact run_script call passed review (for example via a single-use
	// "once" approval), include its single non-protected target app for this
	// invocation while still blocking pivots to any other application.
	if len(args) > 0 {
		if target := op.resolveAppTarget(ctx, "run_script", args); target != nil && target.DenyReason == "" && target.BundleID != "" {
			addBundle(target.BundleID, target.App)
		}
	}
	return allow
}
