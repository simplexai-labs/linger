// Package voice owns the voice features' business: the Live voice's tool
// calls, Captures and their transcript Documents, recording tasks, Capture
// questions, voice events and Pocket notes.
package voice

import (
	"log/slog"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentconnectedapps"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentregistry"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/collaboration"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/memoryclient"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/reminder"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/secretbox"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicecaptureqa"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicedictation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicequicknotes"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/workitem"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// Deps are the services the voice features call.
type Deps struct {
	Pool               *pgxpool.Pool
	Artifacts          artifactstore.ObjectStore
	Documents          *document.Service
	DocumentComments   *document.CommentService
	Collaboration      *collaboration.Service
	Canvas             *agentconnectedapps.Canvas
	AgentConnectedApps *agentconnectedapps.Service
	Agents             *agentregistry.Service
	Reminders          *reminder.Service
	WorkItems          *workitem.Service
	// TypedCards answers the approval cards the user decides by voice.
	TypedCards     *typedcard.Service
	Memory         *memoryclient.Client
	LocalComputers roomagent.LocalComputerManagement
	// Answerer answers recording questions; nil when no model is configured.
	Answerer voicecaptureqa.Answerer
	// QuickNotes writes a finished recording's quick notes; nil when no model
	// is configured.
	QuickNotes voicequicknotes.Writer
	// DictationPolisher rewrites dictated passages; nil when no model is
	// configured.
	DictationPolisher voicedictation.Polisher
	// DictationAPI rewrites on the deployment's own API and defaults to the
	// real client. DictationBox seals that API's key; nil means no key can be
	// saved.
	DictationAPI DictationAPI
	DictationBox *secretbox.Box
	// VoiceMedia is nil when no voice media provider is configured.
	VoiceMedia voicemedia.Plane
	Logger     *slog.Logger
}

// Service runs the voice features' commands and reads.
type Service struct {
	pool               *pgxpool.Pool
	queries            *store.Queries
	artifacts          artifactstore.ObjectStore
	documents          *document.Service
	documentComments   *document.CommentService
	collaboration      *collaboration.Service
	canvas             *agentconnectedapps.Canvas
	agentConnectedApps *agentconnectedapps.Service
	agents             *agentregistry.Service
	reminders          *reminder.Service
	workItems          *workitem.Service
	typedCards         *typedcard.Service
	memory             *memoryclient.Client
	localComputers     roomagent.LocalComputerManagement
	answerer           voicecaptureqa.Answerer
	quickNotes         voicequicknotes.Writer
	dictationPolisher  voicedictation.Polisher
	dictationAPI       DictationAPI
	dictationBox       *secretbox.Box
	// dictationStore is the store the dictation settings read and write.
	dictationStore dictationStore
	voiceMedia     voicemedia.Plane
	logger         *slog.Logger
	// slackSelfDMs keeps each Slack connection's DM with its own user;
	// Slack never changes a DM's channel.
	slackSelfDMs sync.Map
	// savedCanvasDrafts keeps, per canvas and Gmail connection, the draft
	// last saved from it and a digest of what was saved, so a send that
	// follows unchanged skips saving the same draft again.
	savedCanvasDrafts sync.Map
	// canvasDraftJobs holds, per canvas and Gmail connection, the draft
	// save a question started.
	canvasDraftJobs sync.Map
	// canvasDraftSyncs holds, per Document, the timer that saves its draft
	// ahead once it stops changing.
	canvasDraftSyncs sync.Map
}

// savedCanvasDraft is one Gmail draft saved from a canvas.
// canvasDraftJob is a draft save running while the user hears a question.
// Its results are read only after done closes.
type canvasDraftJob struct {
	digest string
	done   chan struct{}
	saved  savedCanvasDraft
	output string
	err    error
}

// canvasDraftSync is a pending save ahead of one canvas's draft.
type canvasDraftSync struct {
	timer *time.Timer
}

type savedCanvasDraft struct {
	draftID, digest string
	// attachments names the files the draft carries.
	attachments []string
}

// New builds the Service.
func New(deps Deps) *Service {
	dictationAPI := deps.DictationAPI
	if dictationAPI == nil {
		dictationAPI = voicedictation.NewAPIPolisher()
	}
	queries := store.New(deps.Pool)
	return &Service{
		pool: deps.Pool, queries: queries, dictationStore: queries, artifacts: deps.Artifacts,
		documents: deps.Documents, documentComments: deps.DocumentComments, collaboration: deps.Collaboration, canvas: deps.Canvas,
		agentConnectedApps: deps.AgentConnectedApps, agents: deps.Agents, reminders: deps.Reminders, workItems: deps.WorkItems, typedCards: deps.TypedCards,
		memory: deps.Memory, localComputers: deps.LocalComputers, answerer: deps.Answerer, quickNotes: deps.QuickNotes, dictationPolisher: deps.DictationPolisher, dictationAPI: dictationAPI, dictationBox: deps.DictationBox, voiceMedia: deps.VoiceMedia, logger: deps.Logger,
	}
}

var internal = collaboration.Internal

func textValue(value string) pgtype.Text {
	return pgtype.Text{String: value, Valid: value != ""}
}

func documentVersionModel(value document.Version) httpapi.DocumentVersion {
	model := httpapi.DocumentVersion{
		Id: value.ID, DocumentId: value.DocumentID, VersionNumber: value.VersionNumber,
		Filename: value.Filename, RepresentationFormat: value.RepresentationFormat,
		MediaType: value.MediaType, SizeBytes: value.SizeBytes, Sha256: value.SHA256,
		CreatedBy: httpapi.ActorRef{
			Id: value.CreatedBy.ID, TenantId: value.CreatedBy.TenantID,
			Kind: httpapi.ActorKind(value.CreatedBy.Kind), DisplayName: value.CreatedBy.DisplayName,
		},
		Source:    httpapi.DocumentVersionSource(value.Source),
		CreatedAt: value.CreatedAt,
	}
	model.SourceRevisionId = value.SourceRevisionID
	model.BaseVersionId = value.BaseVersionID
	model.SourceInvocationId = value.SourceInvocationID
	if value.ExporterSchemaVersion > 0 {
		model.ExporterSchemaVersion = &value.ExporterSchemaVersion
	}
	return model
}
