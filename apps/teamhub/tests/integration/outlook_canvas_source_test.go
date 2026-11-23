package integration_test

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentconnectedapps"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
)

// An Outlook replacement is several writes. A partial upload must invalidate
// the old source binding before an Agent can request or execute a send.
func TestOutlookCanvasPartialUpdateInvalidatesThePreviousDraft(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newTaskWorkerEnv(t)
	roomID := createPrivateRoom(t, env, alice, "Outlook canvas", "outlook-canvas")
	if code, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); code != http.StatusOK {
		t.Fatalf("member=%d %s", code, body)
	}
	issued, err := agentcredential.New(env.pool).IssueManaged(t.Context(), acmeOfficialAgentManagementID, "Outlook canvas")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), `
 INSERT INTO external_connections(id,account_id,provider,upstream_connection_id,status,identity_label,toolkit_slug) VALUES('connection_outlook_canvas','account_alice','outlook','upstream_outlook_canvas','active','alice@example.test','outlook');
 INSERT INTO external_connection_agent_grants(id,connection_id,tenant_id,agent_actor_id,represented_human_actor_id,status) VALUES('grant_outlook_canvas','connection_outlook_canvas','tenant_acme','actor_acme_official','actor_acme_alice','active');
 INSERT INTO documents(id,tenant_id,title,format,owner_actor_id,owner_actor_kind,creator_actor_id,creator_actor_kind,status) VALUES('document_outlook_guard','tenant_acme','Mail','blocknote','actor_acme_alice','human','actor_acme_alice','human','active')`); err != nil {
		t.Fatal(err)
	}
	provider := &outlookConfirmationProvider{}
	service := agentconnectedapps.New(env.pool, agentauth.New(env.pool), newFakeComposio(t).externalSources(t, env.pool, nil), provider)
	source := &confirmationCanvasSource{digest: "sha256:" + strings.Repeat("a", 64)}
	service.SetCanvasReader(source)
	ctx := agentauth.WithTarget(t.Context(), "room", roomID)
	built := agentconnectedapps.CanvasDraft{DocumentID: "document_outlook_guard", SourceDigest: source.digest, Outlook: &composio.OutlookDraftMessage{To: []string{"bob@example.test"}, Subject: "Plan", HTML: "Hello"}}
	save := func() error {
		_, err := service.SaveMailCanvasDraft(ctx, issued.AccessToken, "connection_outlook_canvas", "outlook", "draft-1", built)
		return err
	}
	if err := save(); err != nil {
		t.Fatal(err)
	}
	input := agentconnectedapps.ExecuteInput{ConnectionID: "connection_outlook_canvas", ToolSlug: "OUTLOOK_SEND_DRAFT", ToolVersion: "20261015_00", Arguments: map[string]any{"message_id": "draft-1"}}
	held, err := service.Execute(ctx, issued.AccessToken, input)
	if err != nil || held.Confirmation == nil {
		t.Fatalf("confirmation=%+v err=%v", held, err)
	}
	provider.failSave = true
	if err := save(); err == nil {
		t.Fatal("partial upload reported success")
	}
	var digest string
	if err := env.pool.QueryRow(t.Context(), `SELECT source_digest FROM gmail_canvas_drafts WHERE connection_id='connection_outlook_canvas' AND draft_id='draft-1'`).Scan(&digest); err != nil {
		t.Fatal(err)
	}
	if digest == source.digest {
		t.Fatal("partial upload left the old binding valid")
	}
	if _, err := service.Execute(ctx, issued.AccessToken, input); err == nil {
		t.Fatal("partial draft accepted a confirmation")
	}
	if provider.sends != 0 {
		t.Fatal("partial draft was sent")
	}
	provider.failSave = false
	if err := save(); err != nil {
		t.Fatal(err)
	}
	if result, err := service.Execute(ctx, issued.AccessToken, input); err != nil || result.Confirmation == nil {
		t.Fatalf("repaired draft=%+v err=%v", result, err)
	}
	source.digest = "sha256:" + strings.Repeat("b", 64)
	if _, err := service.Execute(ctx, issued.AccessToken, input); err == nil {
		t.Fatal("edited canvas accepted its old draft")
	}
}

type outlookConfirmationProvider struct {
	confirmationToolProvider
	failSave bool
}

func (p *outlookConfirmationProvider) SaveOutlookDraft(context.Context, string, string, composio.OutlookDraftMessage) (composio.GmailDraft, error) {
	if p.failSave {
		return composio.GmailDraft{}, errors.New("attachment upload interrupted")
	}
	return composio.GmailDraft{DraftID: "draft-1"}, nil
}

func (p *outlookConfirmationProvider) ExecuteTool(_ context.Context, _, _, slug, _ string, _ map[string]any) (composio.ToolExecution, error) {
	if slug == "OUTLOOK_LIST_OUTLOOK_ATTACHMENTS" {
		return composio.ToolExecution{Successful: true, Data: map[string]any{"value": []any{}}}, nil
	}
	if slug == "OUTLOOK_GET_MESSAGE" {
		return composio.ToolExecution{Successful: true, Data: map[string]any{"id": "draft-1", "isDraft": true, "subject": "Plan", "body": map[string]string{"content": "Hello", "contentType": "HTML"}, "toRecipients": []any{map[string]any{"emailAddress": map[string]string{"address": "bob@example.test"}}}}}, nil
	}
	p.sends++
	return composio.ToolExecution{Successful: true}, nil
}
