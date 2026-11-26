package localmodels

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

const (
	localModelsLLMProvider = "localmodels-llm"
	localModelsLibPrefix   = "localmodels-lib-"
	maxStorageWalkEntries  = 10_000
	storageSummaryEvent    = "local_models.storage_summary"
	bifrostHygieneEvent    = "local_models.bifrost_hygiene"
)

type providerEndpointKeys struct {
	baseURL string
	keys    map[string]struct{}
}

func normalizeLoopbackBaseURL(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return ""
	}
	host := strings.ToLower(parsed.Hostname())
	switch host {
	case "localhost", "127.0.0.1", "::1":
		host = "127.0.0.1"
	default:
		return ""
	}
	port := parsed.Port()
	authority := host
	if port != "" {
		authority += ":" + port
	}
	path := strings.TrimRight(parsed.Path, "/")
	return strings.ToLower(parsed.Scheme) + "://" + authority + path
}

func extractProviderKeys(raw json.RawMessage) map[string]struct{} {
	keys := make(map[string]struct{})
	var list []json.RawMessage
	if err := json.Unmarshal(raw, &list); err != nil {
		return keys
	}
	for _, entry := range list {
		var str string
		if err := json.Unmarshal(entry, &str); err == nil {
			if trimmed := strings.TrimSpace(str); trimmed != "" {
				keys[trimmed] = struct{}{}
			}
			continue
		}
		var obj struct {
			Value string `json:"value"`
			Key   string `json:"key"`
		}
		if err := json.Unmarshal(entry, &obj); err == nil {
			for _, candidate := range []string{obj.Value, obj.Key} {
				if trimmed := strings.TrimSpace(candidate); trimmed != "" {
					keys[trimmed] = struct{}{}
				}
			}
		}
	}
	return keys
}

func extractProviderEndpointKeys(raw json.RawMessage) providerEndpointKeys {
	var doc struct {
		BaseURL       string `json:"base_url"`
		NetworkConfig *struct {
			BaseURL string `json:"base_url"`
		} `json:"network_config"`
		CustomProviderConfig *struct {
			BaseURL string `json:"base_url"`
		} `json:"custom_provider_config"`
		Keys json.RawMessage `json:"keys"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return providerEndpointKeys{}
	}
	candidates := []string{doc.BaseURL}
	if doc.NetworkConfig != nil {
		candidates = append(candidates, doc.NetworkConfig.BaseURL)
	}
	if doc.CustomProviderConfig != nil {
		candidates = append(candidates, doc.CustomProviderConfig.BaseURL)
	}
	baseURL := ""
	for _, candidate := range candidates {
		if normalized := normalizeLoopbackBaseURL(candidate); normalized != "" {
			baseURL = normalized
			break
		}
	}
	return providerEndpointKeys{
		baseURL: baseURL,
		keys:    extractProviderKeys(doc.Keys),
	}
}

func providerKeysDiffer(a, b map[string]struct{}) bool {
	if len(b) == 0 {
		return false
	}
	for key := range b {
		if _, ok := a[key]; !ok {
			return true
		}
	}
	for key := range a {
		if _, ok := b[key]; !ok {
			return true
		}
	}
	return false
}

// pruneStaleLocalModelsLLMProvider removes a stale "localmodels-llm" entry
// from <bifrostDir>/config.json when it duplicates a loopback
// "localmodels-lib-*" provider on the same base URL with a different key.
// It creates config.json.bak once and writes the updated config atomically.
func pruneStaleLocalModelsLLMProvider(bifrostDir string) (bool, error) {
	if bifrostDir == "" {
		return false, nil
	}
	cfgPath := filepath.Join(bifrostDir, "config.json")
	info, err := os.Lstat(cfgPath)
	if err != nil || !info.Mode().IsRegular() {
		return false, nil
	}
	raw, err := readBounded(cfgPath, maxOwnedFileBytes)
	if err != nil {
		return false, err
	}
	var top map[string]json.RawMessage
	if err := json.Unmarshal(raw, &top); err != nil || top == nil {
		return false, nil
	}
	providersRaw, ok := top["providers"]
	if !ok {
		return false, nil
	}
	var providers map[string]json.RawMessage
	if err := json.Unmarshal(providersRaw, &providers); err != nil || providers == nil {
		return false, nil
	}
	llmRaw, hasLLM := providers[localModelsLLMProvider]
	if !hasLLM {
		return false, nil
	}
	llm := extractProviderEndpointKeys(llmRaw)
	if llm.baseURL == "" {
		return false, nil
	}
	shouldPrune := false
	for name, candidateRaw := range providers {
		if !strings.HasPrefix(name, localModelsLibPrefix) {
			continue
		}
		lib := extractProviderEndpointKeys(candidateRaw)
		if lib.baseURL == llm.baseURL && providerKeysDiffer(llm.keys, lib.keys) {
			shouldPrune = true
			break
		}
	}
	if !shouldPrune {
		return false, nil
	}

	bakPath := filepath.Join(bifrostDir, "config.json.bak")
	bakFile, err := os.OpenFile(bakPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err == nil {
		_, writeErr := bakFile.Write(raw)
		closeErr := bakFile.Close()
		if writeErr != nil || closeErr != nil {
			_ = os.Remove(bakPath)
			if writeErr != nil {
				return false, writeErr
			}
			return false, closeErr
		}
	} else if !errors.Is(err, os.ErrExist) {
		return false, err
	}

	delete(providers, localModelsLLMProvider)
	updatedProviders, err := json.Marshal(providers)
	if err != nil {
		return false, err
	}
	top["providers"] = updatedProviders
	encoded, err := json.MarshalIndent(top, "", "  ")
	if err != nil {
		return false, err
	}
	encoded = append(encoded, '\n')

	tmpFile, err := os.CreateTemp(bifrostDir, ".config.json.tmp-*")
	if err != nil {
		return false, err
	}
	tmpName := tmpFile.Name()
	cleanupTmp := true
	defer func() {
		if cleanupTmp {
			_ = os.Remove(tmpName)
		}
	}()
	if err := tmpFile.Chmod(0o600); err != nil {
		_ = tmpFile.Close()
		return false, err
	}
	if _, err := tmpFile.Write(encoded); err != nil {
		_ = tmpFile.Close()
		return false, err
	}
	if err := tmpFile.Close(); err != nil {
		return false, err
	}
	if err := os.Rename(tmpName, cfgPath); err != nil {
		return false, err
	}
	cleanupTmp = false
	return true, nil
}

func boundedDirBytes(ctx context.Context, root string, remaining *int) (uint64, bool) {
	if root == "" || *remaining <= 0 {
		return 0, false
	}
	info, err := os.Lstat(root)
	if err != nil {
		return 0, false
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return 0, false
	}
	var total uint64
	truncated := false
	_ = filepath.WalkDir(root, func(_ string, entry fs.DirEntry, walkErr error) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if walkErr != nil {
			return nil
		}
		if *remaining <= 0 {
			truncated = true
			return fs.SkipAll
		}
		*remaining--
		if entry.Type()&os.ModeSymlink != 0 {
			if entry.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if entry.IsDir() {
			return nil
		}
		entryInfo, infoErr := entry.Info()
		if infoErr == nil && entryInfo.Mode().IsRegular() && entryInfo.Size() > 0 {
			total += uint64(entryInfo.Size())
		}
		return nil
	})
	return total, truncated
}

func logStorageSummary(ctx context.Context, stateDir, baseDir string) {
	if stateDir == "" && baseDir == "" {
		return
	}
	remaining := maxStorageWalkEntries
	seen := make(map[string]struct{})
	measure := func(dir string) (uint64, bool) {
		if dir == "" {
			return 0, false
		}
		cleaned := filepath.Clean(dir)
		if _, dup := seen[cleaned]; dup {
			return 0, false
		}
		seen[cleaned] = struct{}{}
		return boundedDirBytes(ctx, cleaned, &remaining)
	}
	modelsBytes, t1 := measure(baseDir)
	toolsBytes, t2 := measure(ToolsDirectory(stateDir))
	bifrostBytes, t3 := measure(BifrostDirectory(stateDir))
	stateBytes, t4 := measure(stateDir)
	totalBytes := modelsBytes + toolsBytes + bifrostBytes + stateBytes
	slog.Info(storageSummaryEvent,
		"models_bytes", modelsBytes,
		"tools_bytes", toolsBytes,
		"bifrost_bytes", bifrostBytes,
		"state_bytes", stateBytes,
		"total_bytes", totalBytes,
		"truncated", t1 || t2 || t3 || t4,
	)
}

func (l *Library) runStartupHygiene(ctx context.Context) {
	if l.tool == nil {
		return
	}
	stateDir := l.tool.StateDirectory
	checked := make(map[string]struct{})
	checkDir := func(dir string) {
		if dir == "" {
			return
		}
		cleaned := filepath.Clean(dir)
		if _, seen := checked[cleaned]; seen {
			return
		}
		checked[cleaned] = struct{}{}
		pruned, err := pruneStaleLocalModelsLLMProvider(cleaned)
		if err != nil {
			slog.Warn(bifrostHygieneEvent, "phase", "failed", "error", err)
			return
		}
		if pruned {
			slog.Info(bifrostHygieneEvent, "pruned_provider", localModelsLLMProvider)
		}
	}
	checkDir(BifrostDirectory(stateDir))
	if rec, ok := readOwnedBifrostRecord(ToolsDirectory(stateDir)); ok && rec.appDir != "" {
		checkDir(rec.appDir)
	}
	logStorageSummary(ctx, stateDir, l.tool.BaseDirectory)
}
