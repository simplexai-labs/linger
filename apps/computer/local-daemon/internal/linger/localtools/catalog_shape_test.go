package localtools

import (
	"encoding/json"
	"runtime"
	"strings"
	"testing"
)

// Every request carries the computer tools, so input reaches Cua only as
// run_actions steps and no Cua session field reaches the model.
func TestCuaCatalogListsInputOnlyThroughRunActions(t *testing.T) {
	session := json.RawMessage(`{"type":"object","properties":{"session":{"type":"string"},"pid":{"type":"integer"},"cursor_id":{"type":"string"}},"required":["session","pid"]}`)
	var catalog []tool
	for _, name := range []string{"click", "drag", "type_text", "hotkey", "move_cursor", "list_windows", "start_session"} {
		catalog = append(catalog, tool{Name: name, Description: "Cua's own text.", InputSchema: session})
	}
	tools, err := cuaCatalog(catalog)
	if err != nil {
		t.Fatal(err)
	}
	listed := map[string]tool{}
	for _, item := range tools {
		listed[item.Name] = item
		if text := string(item.InputSchema); strings.Contains(text, `"session"`) {
			t.Fatalf("%s shows Cua's session: %s", item.Name, text)
		}
	}
	for name := range inputTools {
		if _, found := listed[name]; found {
			t.Fatalf("%s is listed outside run_actions", name)
		}
	}
	if _, found := listed["start_session"]; found {
		t.Fatal("a tool outside cuaTools is listed")
	}
	actions, found := listed["run_actions"]
	if !found || !strings.Contains(string(actions.InputSchema), `"drag"`) {
		t.Fatalf("run_actions does not carry every input: %s", actions.InputSchema)
	}
	if runtime.GOOS == "darwin" {
		move := listed["move_cursor"]
		if move.Description == "Cua's own text." || strings.Contains(string(move.InputSchema), "cursor_id") {
			t.Fatalf("move_cursor keeps Cua's shape: %s %s", move.Description, move.InputSchema)
		}
	}
}

func TestBrowserCatalogDropsPromptFieldsAndSchemaURL(t *testing.T) {
	catalog := []tool{
		{Name: "browser_click", InputSchema: json.RawMessage(`{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"element":{"type":"string","description":"Human-readable element description used to obtain permission to interact with the element"},"target":{"type":"string","description":"Exact target element reference from the page snapshot, or a unique element selector"}},"required":["target"]}`)},
		{Name: "browser_fill_form", InputSchema: json.RawMessage(`{"type":"object","properties":{"fields":{"type":"array","items":{"type":"object","properties":{"element":{"type":"string"},"target":{"type":"string"},"value":{"type":"string"}},"required":["target","value"]}}}}`)},
		{Name: "browser_install", InputSchema: json.RawMessage(`{"type":"object"}`)},
	}
	tools := filterBrowserTools(catalog)
	if len(tools) != 2 {
		t.Fatalf("tools = %v", tools)
	}
	for _, item := range tools {
		text := string(item.InputSchema)
		if strings.Contains(text, "$schema") || strings.Contains(text, `"element"`) || !strings.Contains(text, `"target"`) {
			t.Fatalf("%s: %s", item.Name, text)
		}
	}
	if !strings.Contains(string(tools[0].InputSchema), browserFieldNotes["target"]) {
		t.Fatalf("target keeps Playwright's description: %s", tools[0].InputSchema)
	}
}
