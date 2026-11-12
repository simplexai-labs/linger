package provider

import (
	"encoding/json"
	"unicode/utf8"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/redact"
)

// Publish only fields used by the product's tool summaries, not message bodies,
// environment maps, credentials, file contents, or full patches. Computer
// tools publish their target and keys but never the text or value arguments
// they type or set, element tokens, or window ids. A script is published as
// written, clipped, so text it types literally is shown, as a command line's
// is. The Room status line's title and steps come first, so the size limit
// never drops them.
func activityInput(input map[string]any, status activityStatus) []map[string]any {
	if arguments, ok := input["arguments"].(map[string]any); ok {
		input = arguments
	} else if arguments, ok := input["arguments"].(string); ok {
		var decoded map[string]any
		if json.Unmarshal([]byte(arguments), &decoded) == nil {
			input = decoded
		}
	}
	safe := redact.InputMap(input)
	if changes, ok := safe["changes"].([]any); ok && safe["paths"] == nil {
		paths := []string{}
		for _, change := range changes {
			if entry, ok := change.(map[string]any); ok {
				if path, ok := entry["path"].(string); ok {
					paths = append(paths, path)
				}
			}
		}
		if len(paths) > 0 {
			safe["paths"] = paths
		}
	}
	summary := make(map[string]any)
	if status.title != "" {
		summary["status_title"] = redact.Text(clip(status.title, 200))
	}
	if len(status.steps) > 0 {
		steps := make([]any, 0, len(status.steps))
		for _, step := range status.steps {
			steps = append(steps, redact.Text(step))
		}
		summary["status_steps"] = steps
	}
	for _, key := range []string{"cmd", "command", "file_path", "path", "filename", "paths", "pattern", "query", "q", "url", "target", "recipient", "threadId", "thread_id", "room_id", "task_name", "agent_id", "duration_ms", "yield_time_ms", "plan", "steps", "bundle_id", "urls", "name", "role", "direction", "key", "keys", "actions", "script"} {
		value, ok := safe[key]
		if !ok {
			continue
		}
		switch typed := value.(type) {
		case string:
			if utf8.RuneCountInString(typed) > 500 {
				value = string([]rune(typed)[:500]) + "…"
			}
		case float64, int, int64, json.Number:
		case []any:
			// Keep public plan steps, file paths, and batch steps' tool names,
			// without arbitrary nested data such as typed text.
			values := make([]any, 0, len(typed))
			for _, entry := range typed {
				if key == "actions" {
					if fields, ok := entry.(map[string]any); ok {
						if tool, ok := fields["tool"].(string); ok {
							values = append(values, tool)
						}
					}
				} else if key == "plan" || key == "steps" {
					step := map[string]any{}
					if fields, ok := entry.(map[string]any); ok {
						for _, name := range []string{"step", "status"} {
							if text, ok := fields[name].(string); ok {
								step[name] = text
							}
						}
					}
					values = append(values, step)
				} else if path, ok := entry.(string); ok {
					values = append(values, path)
				}
			}
			value = values
		case []string:
		default:
			continue
		}
		summary[key] = value
		encoded, err := json.Marshal(summary)
		// Keep valid JSON within the presentation contract's 4,000-character block.
		if err != nil || utf8.RuneCount(encoded) > 4000 {
			delete(summary, key)
		}
	}
	if len(summary) == 0 {
		return nil
	}
	encoded, err := json.Marshal(summary)
	if err != nil {
		return nil
	}
	return []map[string]any{{"label": "Input", "format": "json", "content": string(encoded)}}
}
