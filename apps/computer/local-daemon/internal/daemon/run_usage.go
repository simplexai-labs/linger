package daemon

import (
	"encoding/json"
	"regexp"
	"sort"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

// serviceFeatureAntigravityUsageProvider in runner.welcome's service_features
// says the Agent Service accepts "antigravity" as a RunUsage item provider.
// Older services close the connection on unknown provider values, so the
// Daemon reports "unknown" when absent.
const serviceFeatureAntigravityUsageProvider = "antigravity_usage_provider"

// Matches the TeamHub model pattern; it also rejects placeholders such as "<synthetic>".
var reportedModelPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$`)

func reportedTokenCounts(usage native.TokenCount, reasoning bool) map[string]any {
	value := map[string]any{"input": usage.Input, "cache_read": usage.CacheRead, "cache_write": usage.CacheWrite, "output": usage.Output}
	if reasoning && usage.Reasoning > 0 && usage.Reasoning <= usage.Output {
		value["reasoning"] = usage.Reasoning
	}
	return value
}
func reportedRunUsage(spec provider.OperationSpec, result provider.Result, antigravityProvider bool) []map[string]any {
	if spec.OperationKind != "run.start" {
		return nil
	}
	providerName := "unknown"
	switch spec.Provider {
	case "codex":
		providerName = "openai"
	case "claude":
		providerName = "anthropic"
	case "antigravity":
		if antigravityProvider {
			providerName = "antigravity"
		}
	}
	includeReasoning := spec.Provider == "codex" || spec.Provider == "antigravity"
	models := make([]string, 0, len(result.Usage))
	for model := range result.Usage {
		models = append(models, model)
	}
	sort.Strings(models)
	usage := make([]map[string]any, 0, len(models))
	for _, model := range models {
		counts := result.Usage[model]
		if !reportedModelPattern.MatchString(model) || counts.Input == 0 && counts.CacheRead == 0 && counts.CacheWrite == 0 && counts.Output == 0 {
			continue
		}
		value := reportedTokenCounts(counts, includeReasoning)
		value["model"], value["provider"] = model, providerName
		if last, ok := result.LastUsage[model]; ok {
			value["last"] = reportedTokenCounts(last, includeReasoning)
		}
		if result.CompactionCount != nil {
			count := int64(0)
			if len(usage) == 0 {
				count = *result.CompactionCount
			}
			value["compaction_count"] = count
		}
		usage = append(usage, value)
	}
	if len(usage) == 0 {
		return nil
	}
	return usage
}
func terminalWithUsage(payload map[string]any, spec provider.OperationSpec, result provider.Result, antigravityProvider bool) json.RawMessage {
	if usage := reportedRunUsage(spec, result, antigravityProvider); len(usage) > 0 {
		payload["usage"] = usage
	}
	if spec.OperationKind == "run.start" && spec.PrepareNativeResume != nil {
		payload["prepare_native_resume"] = spec.PrepareNativeResume
	}
	if spec.OperationKind == "run.start" && result.NativeResume != nil {
		payload["native_resume"] = result.NativeResume
	}
	return mustJSON(payload)
}

// downgradeAntigravityUsageProvider rewrites "provider": "antigravity" to
// "unknown" inside retained terminal usage arrays so replaying to an Agent
// Service without antigravity_usage_provider never triggers a protocol close.
func downgradeAntigravityUsageProvider(event protocol.Event) protocol.Event {
	if event.RuntimeType != "antigravity" || len(event.Payload) == 0 {
		return event
	}
	switch event.Type {
	case protocol.EventOperationCompleted, protocol.EventOperationFailed, protocol.EventOperationCancelled:
	default:
		return event
	}
	var top map[string]json.RawMessage
	if json.Unmarshal(event.Payload, &top) != nil {
		return event
	}
	changed := false
	if rawUsage, ok := top["usage"]; ok {
		if rewritten, ok := downgradeAntigravityUsageArray(rawUsage); ok {
			top["usage"] = rewritten
			changed = true
		}
	}
	if event.Type == protocol.EventOperationCompleted {
		if rawResult, ok := top["result"]; ok {
			var nested map[string]json.RawMessage
			if json.Unmarshal(rawResult, &nested) == nil {
				if rawUsage, ok := nested["usage"]; ok {
					if rewritten, ok := downgradeAntigravityUsageArray(rawUsage); ok {
						nested["usage"] = rewritten
						if encodedResult, err := json.Marshal(nested); err == nil {
							top["result"] = encodedResult
							changed = true
						}
					}
				}
			}
		}
	}
	if !changed {
		return event
	}
	encoded, err := json.Marshal(top)
	if err != nil {
		return event
	}
	event.Payload = encoded
	return event
}

func downgradeAntigravityUsageArray(raw json.RawMessage) (json.RawMessage, bool) {
	var items []map[string]json.RawMessage
	if json.Unmarshal(raw, &items) != nil {
		return nil, false
	}
	changed := false
	for i := range items {
		rawProvider, ok := items[i]["provider"]
		if !ok {
			continue
		}
		var providerName string
		if json.Unmarshal(rawProvider, &providerName) == nil && providerName == "antigravity" {
			items[i]["provider"] = json.RawMessage(`"unknown"`)
			changed = true
		}
	}
	if !changed {
		return nil, false
	}
	encoded, err := json.Marshal(items)
	if err != nil {
		return nil, false
	}
	return encoded, true
}
