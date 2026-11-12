package localtools

import (
	"encoding/json"
	"strings"
	"testing"
)

func readResult(t *testing.T, structured map[string]any) json.RawMessage {
	t.Helper()
	encoded, err := json.Marshal(map[string]any{"structuredContent": structured})
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func readCall(arguments map[string]any) map[string]any {
	return map[string]any{"name": "get_window_state", "arguments": arguments}
}

func TestSnapshotRowsCarriesTokensOverTheComputersOwnReads(t *testing.T) {
	s := newSnapshotRows()
	agentTree := "- [0] AXWindow \"Shop\"\n  - [4] AXLink \"Kettle\" [actions=[press]]\n  - [5] AXButton \"Add to cart\" [actions=[press]]"
	s.observe(readCall(nil), readResult(t, map[string]any{"snapshot_id": "s00000001", "pid": 7, "window_id": 9, "tree_markdown": agentTree}))
	// The Computer's tab check reads the whole window: the link is unchanged,
	// the button now reads differently, and its rows sit deeper.
	ownTree := "- [0] AXWindow \"Shop\"\n      - [4] AXLink \"Kettle\" [actions=[press]]\n      - [5] AXButton \"Added\" [actions=[press]]"
	s.observe(readCall(nil), readResult(t, map[string]any{"snapshot_id": "s00000002", "pid": 7, "window_id": 9, "tree_markdown": ownTree}))

	link := map[string]any{"element_token": "s00000001:4"}
	s.remap(link)
	if link["element_token"] != "s00000002:4" {
		t.Fatalf("unchanged row = %v, want s00000002:4", link["element_token"])
	}
	button := map[string]any{"element_token": "s00000001:5"}
	s.remap(button)
	if button["element_token"] != "s00000001:5" {
		t.Fatalf("changed row = %v, want its own stale token", button["element_token"])
	}

	// A diff read keeps the rows it does not list.
	s.observe(readCall(nil), readResult(t, map[string]any{"snapshot_id": "s00000003", "pid": 7, "window_id": 9, "since": "s00000002", "since_status": "diff",
		"tree_diff": "since s00000002: 0 added, 1 changed, 0 removed.\n~ [5] AXButton \"Add to cart\" [actions=[press]]"}))
	s.observe(readCall(nil), readResult(t, map[string]any{"snapshot_id": "s00000004", "pid": 7, "window_id": 9, "tree_markdown": agentTree}))
	for _, token := range []string{"s00000003:4", "s00000003:5", "s00000001:5"} {
		arguments := map[string]any{"element_token": token}
		s.remap(arguments)
		if want := "s00000004:" + token[10:]; arguments["element_token"] != want {
			t.Fatalf("%s = %v, want %s", token, arguments["element_token"], want)
		}
	}

	script := map[string]any{"script": `await app.click("s00000001:4"); await app.click("s00000099:4")`}
	s.remap(script)
	if want := `await app.click("s00000004:4"); await app.click("s00000099:4")`; script["script"] != want {
		t.Fatalf("script = %v, want %s", script["script"], want)
	}

	// The Agent's own read is no input: its tokens still carry over the
	// tab check that follows it.
	s.sent("get_window_state")
	s.observe(readCall(nil), readResult(t, map[string]any{"snapshot_id": "s00000005", "pid": 7, "window_id": 9, "tree_markdown": ownTree}))
	read := map[string]any{"element_token": "s00000004:4"}
	s.remap(read)
	if read["element_token"] != "s00000005:4" {
		t.Fatalf("token of the Agent's read = %v, want s00000005:4", read["element_token"])
	}

	// After an input, an older read is never carried over: the page may
	// have changed under a row that reads the same.
	s.sent("click")
	s.observe(readCall(nil), readResult(t, map[string]any{"snapshot_id": "s00000006", "pid": 7, "window_id": 9, "tree_markdown": agentTree}))
	before := map[string]any{"element_token": "s00000005:4"}
	s.remap(before)
	if before["element_token"] != "s00000005:4" {
		t.Fatalf("read before an input = %v, want its own stale token", before["element_token"])
	}

	// A diff that says the indices shifted keeps only the rows it lists.
	s.observe(readCall(nil), readResult(t, map[string]any{"snapshot_id": "s00000007", "pid": 7, "window_id": 9, "since": "s00000006", "since_status": "diff",
		"tree_diff": "since s00000006: 1 added.\nreindexed: rows after 3 moved by 1\n+ [5] AXLink \"Kettle\" [actions=[press]]"}))
	s.observe(readCall(nil), readResult(t, map[string]any{"snapshot_id": "s00000008", "pid": 7, "window_id": 9, "tree_markdown": agentTree}))
	shifted := map[string]any{"element_token": "s00000007:4"}
	s.remap(shifted)
	if shifted["element_token"] != "s00000007:4" {
		t.Fatalf("row of a reindexed diff = %v, want its own stale token", shifted["element_token"])
	}

	// A script reads inside the driver, so no snapshot is known current.
	s.observe(map[string]any{"name": "run_script"}, json.RawMessage(`{}`))
	after := map[string]any{"element_token": "s00000001:4"}
	s.remap(after)
	if after["element_token"] != "s00000001:4" {
		t.Fatalf("after a script = %v, want the token unchanged", after["element_token"])
	}
}

// A script's reads after its last input come back in its result, so a token
// it returned carries over the Computer's own reads into the next script.
func TestSnapshotRowsCarriesAScriptsTokensIntoTheNextScript(t *testing.T) {
	tree := "- [0] AXWindow \"Shop\"\n  - [4] AXLink \"Kettle\" [actions=[press]]"
	value := map[string]any{scriptReadsKey: []any{map[string]any{"snapshot_id": "s00000011", "pid": 7, "window_id": 9, "tree_markdown": tree}}, "value": map[string]any{"z": 1, "a": "s00000011:4"}}
	encodedValue, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	text := "run_script: ok in 5 ms, 2 driver call(s)\nreturn value: " + string(encodedValue)[:40] + "…\nconsole (1 line(s)):\n  hi\ncalls:\n  1. line 1 get_window_state ok (3 ms): window_id=9"
	result, err := json.Marshal(map[string]any{"content": []any{map[string]any{"type": "text", "text": text}},
		"structuredContent": map[string]any{"ok": true, "value": json.RawMessage(`{"__computer_reads":` + string(mustJSON(t, value[scriptReadsKey])) + `,"value":{"z":1,"a":"s00000011:4"}}`)}})
	if err != nil {
		t.Fatal(err)
	}
	unwrapped, reads := scriptResultReads(result)
	var reply struct {
		Content    []struct{ Text string } `json:"content"`
		Structured struct {
			Value json.RawMessage `json:"value"`
		} `json:"structuredContent"`
	}
	if err := json.Unmarshal(unwrapped, &reply); err != nil || len(reads) != 1 {
		t.Fatalf("reply = %s, reads = %v, error = %v", unwrapped, reads, err)
	}
	if want := "return value: {\"z\":1,\"a\":\"s00000011:4\"}\nconsole (1 line(s)):\n  hi\ncalls:\n"; !strings.Contains(reply.Content[0].Text, want) {
		t.Fatalf("text = %q, want it to hold %q", reply.Content[0].Text, want)
	}
	if string(reply.Structured.Value) != `{"z":1,"a":"s00000011:4"}` {
		t.Fatalf("structured value = %s", reply.Structured.Value)
	}

	s := newSnapshotRows()
	s.observe(map[string]any{"name": "run_script"}, unwrapped)
	s.sent("run_script")
	for _, read := range reads {
		s.record(read)
	}
	// The Computer counts the tabs after the script and checks the tab
	// before the next one; each read replaces the script's snapshot.
	s.observe(readCall(nil), readResult(t, map[string]any{"snapshot_id": "s00000012", "pid": 7, "window_id": 9, "tree_markdown": tree}))
	next := map[string]any{"script": `await app.click("s00000011:4")`}
	s.remap(next)
	if want := `await app.click("s00000012:4")`; next["script"] != want {
		t.Fatalf("next script = %v, want %s", next["script"], want)
	}

	plain := json.RawMessage(`{"content":[{"type":"text","text":"run_script: ok\nreturn value: 1"}],"structuredContent":{"value":1}}`)
	if same, reads := scriptResultReads(plain); string(same) != string(plain) || reads != nil {
		t.Fatalf("a result without reads = %s, %v; want it unchanged", same, reads)
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}
