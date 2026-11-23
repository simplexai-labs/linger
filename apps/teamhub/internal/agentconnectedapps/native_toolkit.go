package agentconnectedapps

import (
	"context"
	"errors"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
)

// NativeToolkit serves the tools of a toolkit TeamHub runs itself rather than
// through Composio. Its tools are admitted, confirmed and logged exactly like
// Composio's: only the call that reaches the provider differs.
type NativeToolkit interface {
	// Toolkit is the toolkit slug its connections record.
	Toolkit() string
	// Owns reports whether slug is one of its tools.
	Owns(slug string) bool
	GetTool(ctx context.Context, slug, version string) (composio.Tool, error)
	ExecuteTool(ctx context.Context, upstreamID, slug, version string, arguments map[string]any) (composio.ToolExecution, error)
	ConnectionStatus(ctx context.Context, upstreamID string) (composio.ConnectionStatus, error)
}

// WithNativeToolkit routes native's tools and connections to it and every
// other call to provider.
func WithNativeToolkit(provider ToolProvider, native NativeToolkit) ToolProvider {
	return routedProvider{ToolProvider: provider, native: native}
}

type routedProvider struct {
	ToolProvider
	native NativeToolkit
}

var (
	errNoFileUpload  = errors.New("the connected app provider stages no files")
	errNoGmailDrafts = errors.New("the connected app provider saves no Gmail drafts")
)

func (p routedProvider) GetTool(ctx context.Context, slug, version string) (composio.Tool, error) {
	if p.native.Owns(slug) {
		return p.native.GetTool(ctx, slug, version)
	}
	return p.ToolProvider.GetTool(ctx, slug, version)
}

func (p routedProvider) ExecuteTool(ctx context.Context, upstreamID, userID, slug, version string, arguments map[string]any) (composio.ToolExecution, error) {
	if p.native.Owns(slug) {
		return p.native.ExecuteTool(ctx, upstreamID, slug, version, arguments)
	}
	return p.ToolProvider.ExecuteTool(ctx, upstreamID, userID, slug, version, arguments)
}

func (p routedProvider) GetConnectionStatusForToolkit(ctx context.Context, upstreamID, toolkit string) (composio.ConnectionStatus, error) {
	if toolkit == p.native.Toolkit() {
		return p.native.ConnectionStatus(ctx, upstreamID)
	}
	return p.ToolProvider.GetConnectionStatusForToolkit(ctx, upstreamID, toolkit)
}

// RequestFileUpload stages files with Composio; native tools take theirs in
// their arguments.
func (p routedProvider) RequestFileUpload(ctx context.Context, request composio.FileUploadRequest) (composio.FileUploadTarget, error) {
	if uploader, ok := p.ToolProvider.(fileUploadProvider); ok {
		return uploader.RequestFileUpload(ctx, request)
	}
	return composio.FileUploadTarget{}, errNoFileUpload
}

// nativeDraftSaver saves a whole message as a draft on a native toolkit's
// connection, for an Agent's canvas draft.
type nativeDraftSaver interface {
	SaveDraftRaw(ctx context.Context, upstreamID, draftID string, raw []byte) (string, error)
}

func (p routedProvider) SaveDraftRaw(ctx context.Context, upstreamID, draftID string, raw []byte) (string, error) {
	if saver, ok := p.native.(nativeDraftSaver); ok {
		return saver.SaveDraftRaw(ctx, upstreamID, draftID, raw)
	}
	return "", errNoGmailDrafts
}

func (p routedProvider) SaveGmailDraft(ctx context.Context, connectedAccountID, draftID, raw string) (composio.GmailDraft, error) {
	if drafts, ok := p.ToolProvider.(gmailDraftProvider); ok {
		return drafts.SaveGmailDraft(ctx, connectedAccountID, draftID, raw)
	}
	return composio.GmailDraft{}, errNoGmailDrafts
}

func (p routedProvider) SaveOutlookDraft(ctx context.Context, accountID, draftID string, message composio.OutlookDraftMessage) (composio.GmailDraft, error) {
	if drafts, ok := p.ToolProvider.(outlookDraftProvider); ok {
		return drafts.SaveOutlookDraft(ctx, accountID, draftID, message)
	}
	return composio.GmailDraft{}, errors.New("the connected app provider saves no Outlook drafts")
}
