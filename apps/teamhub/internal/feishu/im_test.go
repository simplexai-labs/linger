package feishu

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
)

type fakeIMCaller struct {
	calls    []map[string]any
	response map[string]any
	err      error
}

func (f *fakeIMCaller) Call(_ context.Context, tool string, arguments map[string]any) (map[string]any, error) {
	f.calls = append(f.calls, map[string]any{"tool": tool, "arguments": arguments})
	if f.err != nil {
		return nil, f.err
	}
	return f.response, nil
}

func TestIMListChatsCallsTheOwnersChats(t *testing.T) {
	caller := &fakeIMCaller{response: map[string]any{
		"status": "ok",
		"data":   map[string]any{"items": []any{map[string]any{"chat_id": "oc_1", "name": "Acme rollout", "chat_mode": "group"}}},
	}}
	page, err := NewIM(caller.Call).ListChats(context.Background(), 20, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].ChatID != "oc_1" || page.Items[0].Name != "Acme rollout" {
		t.Fatalf("chats = %+v", page.Items)
	}
	if page.NextPageToken != "" {
		t.Fatalf("next page token = %q", page.NextPageToken)
	}
	if len(caller.calls) != 1 || caller.calls[0]["tool"] != "api" {
		t.Fatalf("calls = %+v", caller.calls)
	}
	arguments := caller.calls[0]["arguments"].(map[string]any)
	if arguments["method"] != "GET" || arguments["path"] != "/open-apis/im/v1/chats" {
		t.Fatalf("arguments = %+v", arguments)
	}
	// The tool promises the most active chats first, so the query must say so.
	if got := arguments["params"].(map[string]any)["sort_type"]; got != "ByActiveTimeDesc" {
		t.Fatalf("sort_type = %v", got)
	}
}

func TestIMSendMessagePostsToTheMessagesPath(t *testing.T) {
	caller := &fakeIMCaller{response: map[string]any{
		"status": "ok",
		"data":   map[string]any{"message_id": "om_1"},
	}}
	messageID, err := NewIM(caller.Call).SendMessage(context.Background(), "oc_1", "chat_id", "text", `{"text":"hi"}`)
	if err != nil {
		t.Fatal(err)
	}
	if messageID != "om_1" {
		t.Fatalf("messageID = %q", messageID)
	}
	arguments := caller.calls[0]["arguments"].(map[string]any)
	if arguments["method"] != "POST" || arguments["path"] != "/open-apis/im/v1/messages" {
		t.Fatalf("arguments = %+v", arguments)
	}
	body, _ := json.Marshal(arguments["data"])
	if string(body) != `{"content":"{\"text\":\"hi\"}","msg_type":"text","receive_id":"oc_1"}` {
		t.Fatalf("body = %s", body)
	}
}

func TestIMListMessagesRefusesAnEmptyChat(t *testing.T) {
	caller := &fakeIMCaller{}
	if _, err := NewIM(caller.Call).ListMessages(context.Background(), "  ", 20, ""); err == nil {
		t.Fatal("an empty chat was accepted")
	}
	if len(caller.calls) != 0 {
		t.Fatalf("lark-cli ran for a refused request: %+v", caller.calls)
	}
}

func TestIMIdentityReadsTheOwnAccount(t *testing.T) {
	caller := &fakeIMCaller{response: map[string]any{
		"status": "ok",
		"data":   map[string]any{"open_id": "ou_1", "name": "Dana Lee"},
	}}
	identity, err := NewIM(caller.Call).Identity(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if identity.OpenID != "ou_1" || identity.Name != "Dana Lee" {
		t.Fatalf("identity = %+v", identity)
	}
	arguments := caller.calls[0]["arguments"].(map[string]any)
	if arguments["path"] != "/open-apis/authen/v1/user_info" {
		t.Fatalf("path = %v", arguments["path"])
	}
}

func TestIMBoundToAnotherAccountRefusesEveryCall(t *testing.T) {
	caller := &fakeIMCaller{response: map[string]any{
		"status": "ok",
		"data":   map[string]any{"open_id": "ou_2", "name": "Sam Park"},
	}}
	bound := NewIM(caller.Call).BoundTo("ou_1")
	if _, err := bound.ListChats(context.Background(), 20, ""); !errors.Is(err, ErrIMIdentityChanged) {
		t.Fatalf("err = %v", err)
	}
	// The identity check ran once; the refused call never reached Feishu.
	if len(caller.calls) != 1 {
		t.Fatalf("calls = %+v", caller.calls)
	}
}

func TestIMListMessagesSendsTheNewestFirstQueryAndThePageToken(t *testing.T) {
	caller := &fakeIMCaller{response: map[string]any{
		"status": "ok",
		"data":   map[string]any{"items": []any{}, "page_token": "next-1"},
	}}
	page, err := NewIM(caller.Call).ListMessages(context.Background(), "oc_1", 50, "prev-1")
	if err != nil {
		t.Fatal(err)
	}
	if page.NextPageToken != "next-1" {
		t.Fatalf("next page token = %q", page.NextPageToken)
	}
	arguments := caller.calls[0]["arguments"].(map[string]any)
	if arguments["path"] != "/open-apis/im/v1/messages" {
		t.Fatalf("path = %v", arguments["path"])
	}
	params := arguments["params"].(map[string]any)
	want := map[string]any{"container_id": "oc_1", "container_id_type": "chat", "sort_type": "ByCreateTimeDesc", "page_size": 50, "page_token": "prev-1"}
	if !reflect.DeepEqual(params, want) {
		t.Fatalf("params = %#v, want %#v", params, want)
	}
}

func TestIMStatusCarriesTheComputersRefusal(t *testing.T) {
	caller := &fakeIMCaller{response: map[string]any{"status": "missing_scope", "missing_scopes": []any{"im:message"}}}
	err := NewIM(caller.Call).Status(context.Background())
	var missing *ScopesMissingError
	if !errors.As(err, &missing) || len(missing.Scopes) != 1 || missing.Scopes[0] != "im:message" {
		t.Fatalf("err = %#v", err)
	}
}
