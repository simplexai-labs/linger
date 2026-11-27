package provider

import (
	"maps"
	"strings"
)

const maxWindowsEnvExpandPasses = 4

type windowsRegistrySnapshot struct {
	MachineEnv  map[string]string
	UserEnv     map[string]string
	VolatileEnv map[string]string
	MachinePath string
	UserPath    string
}

// readWindowsRegistryEnv reads Host Machine, User, and Volatile Windows
// registry environment variables; overridden in unit tests.
var readWindowsRegistryEnv = readHostWindowsRegistryEnv

func expandWindowsEnvVars(raw string, lookup func(string) (string, bool)) string {
	if lookup == nil || !strings.ContainsRune(raw, '%') {
		return raw
	}
	current := raw
	for range maxWindowsEnvExpandPasses {
		next := expandWindowsEnvVarsPass(current, lookup)
		if next == current {
			break
		}
		current = next
	}
	return current
}

func expandWindowsEnvVarsPass(raw string, lookup func(string) (string, bool)) string {
	var builder strings.Builder
	for index := 0; index < len(raw); {
		relStart := strings.IndexByte(raw[index:], '%')
		if relStart < 0 {
			builder.WriteString(raw[index:])
			break
		}
		start := index + relStart
		builder.WriteString(raw[index:start])
		relEnd := strings.IndexByte(raw[start+1:], '%')
		if relEnd < 0 {
			builder.WriteString(raw[start:])
			break
		}
		if relEnd == 0 {
			builder.WriteString("%%")
			index = start + 2
			continue
		}
		end := start + 1 + relEnd
		name := raw[start+1 : end]
		if value, ok := lookup(name); ok {
			builder.WriteString(value)
		} else {
			builder.WriteString(raw[start : end+1])
		}
		index = end + 1
	}
	return builder.String()
}

func resolveWindowsRegistryPath(snapshot windowsRegistrySnapshot, source map[string]string) string {
	base := make(map[string]string, len(source))
	for key, value := range source {
		base[strings.ToUpper(key)] = value
	}

	// Expand variables even when installers wrote REG_SZ instead of REG_EXPAND_SZ,
	// resolving Machine variables before overlaying Volatile and User entries.
	machineRaw := maps.Clone(base)
	overlayWindowsEnv(machineRaw, snapshot.MachineEnv)
	machineExpanded := cloneAndExpandWindowsEnv(base, snapshot.MachineEnv, lookupWindowsEnvMap(machineRaw))
	expandedMachinePath := expandWindowsEnvVars(snapshot.MachinePath, lookupWindowsEnvMap(machineExpanded))

	volatileRaw := maps.Clone(machineExpanded)
	overlayWindowsEnv(volatileRaw, snapshot.VolatileEnv)
	volatileExpanded := cloneAndExpandWindowsEnv(machineExpanded, snapshot.VolatileEnv, lookupWindowsEnvMap(volatileRaw))

	userRaw := maps.Clone(volatileExpanded)
	overlayWindowsEnv(userRaw, snapshot.UserEnv)
	userExpanded := cloneAndExpandWindowsEnv(volatileExpanded, snapshot.UserEnv, lookupWindowsEnvMap(userRaw))
	expandedUserPath := expandWindowsEnvVars(snapshot.UserPath, lookupWindowsEnvMap(userExpanded))

	return mergeWindowsSearchPath(expandedMachinePath, expandedUserPath, "")
}

func overlayWindowsEnv(target, source map[string]string) {
	for key, value := range source {
		upper := strings.ToUpper(key)
		if upper == "" || upper == "PATH" {
			continue
		}
		target[upper] = value
	}
}

func cloneAndExpandWindowsEnv(base, overlay map[string]string, lookup func(string) (string, bool)) map[string]string {
	expanded := maps.Clone(base)
	if expanded == nil {
		expanded = make(map[string]string, len(overlay))
	}
	for key, value := range overlay {
		upper := strings.ToUpper(key)
		if upper == "" || upper == "PATH" {
			continue
		}
		expanded[upper] = expandWindowsEnvVars(value, lookup)
	}
	return expanded
}

func lookupWindowsEnvMap(values map[string]string) func(string) (string, bool) {
	return func(name string) (string, bool) {
		if len(values) == 0 {
			return "", false
		}
		value, ok := values[strings.ToUpper(name)]
		return value, ok
	}
}

func splitWindowsPathEntries(raw string) []string {
	parts := strings.Split(raw, ";")
	entries := make([]string, 0, len(parts))
	for _, part := range parts {
		entry := strings.TrimSpace(part)
		if len(entry) >= 2 && entry[0] == '"' && entry[len(entry)-1] == '"' {
			entry = strings.TrimSpace(entry[1 : len(entry)-1])
		}
		if entry == "" {
			continue
		}
		entries = append(entries, entry)
	}
	return entries
}

func isWindowsDriveLetter(b byte) bool {
	return (b >= 'A' && b <= 'Z') || (b >= 'a' && b <= 'z')
}

func canonicalWindowsPathKey(entry string) string {
	cleaned := strings.TrimSpace(entry)
	if len(cleaned) >= 2 && cleaned[0] == '"' && cleaned[len(cleaned)-1] == '"' {
		cleaned = strings.TrimSpace(cleaned[1 : len(cleaned)-1])
	}
	cleaned = strings.ReplaceAll(cleaned, "/", `\`)
	for len(cleaned) > 1 && cleaned[len(cleaned)-1] == '\\' {
		if len(cleaned) == 3 && cleaned[1] == ':' && isWindowsDriveLetter(cleaned[0]) {
			break
		}
		cleaned = cleaned[:len(cleaned)-1]
	}
	return strings.ToLower(cleaned)
}

// mergeWindowsSearchPath merges PATH entries with registry precedence
// (machinePath, then userPath, then inheritedPath). Putting registry paths
// first matches fresh Windows shells and prevents directories later removed from
// the registry from jumping ahead of current entries while retaining
// inherited-only paths at the tail.
func mergeWindowsSearchPath(machinePath, userPath, inheritedPath string) string {
	seen := make(map[string]bool)
	var merged []string
	for _, raw := range []string{machinePath, userPath, inheritedPath} {
		for _, entry := range splitWindowsPathEntries(raw) {
			key := canonicalWindowsPathKey(entry)
			if key == "" || seen[key] {
				continue
			}
			seen[key] = true
			merged = append(merged, entry)
		}
	}
	return strings.Join(merged, ";")
}

// AppendWindowsSearchPath appends dir to the tail of existingPath using the
// Windows PATH canonicalizer and case-insensitive deduplication.
func AppendWindowsSearchPath(existingPath, dir string) string {
	return mergeWindowsSearchPath(existingPath, "", dir)
}

func (c *TerminalEnvironmentCache) resolveWindows(resolved map[string]string) map[string]string {
	c.mu.Lock()
	defer c.mu.Unlock()

	if snapshot, ok := readWindowsRegistryEnv(); ok {
		if registryPath := resolveWindowsRegistryPath(snapshot, resolved); registryPath != "" {
			c.capturedPath = registryPath
			c.hasCaptured = true
			c.lastCaptureAt = c.currentTime()
		}
	}
	inherited := resolved["PATH"]
	if c.hasCaptured {
		resolved["PATH"] = mergeWindowsSearchPath(c.capturedPath, "", inherited)
	} else if inherited != "" {
		resolved["PATH"] = mergeWindowsSearchPath("", "", inherited)
	}
	c.initialized = true
	return resolved
}
