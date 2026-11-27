package agentregistry

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// defaultLocalRuntimeModels stands in for a Runtime diagnostic that reported
// no model catalog of its own; the Runtime then uses its host default model.
var defaultLocalRuntimeModels = map[string]httpapi.AgentModel{
	"claude":      {Id: "claude-default", Label: "Claude default"},
	"codex":       {Id: "codex-default", Label: "Codex default"},
	"pi":          {Id: "pi-default", Label: "Pi default"},
	"antigravity": {Id: "antigravity-default", Label: "Antigravity default"},
}

type storedRuntimeDiagnostic struct {
	Type    string `json:"type"`
	Status  string `json:"status"`
	Version string `json:"version"`
	Error   *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
	Models *[]struct {
		ID                     string   `json:"id"`
		Label                  string   `json:"label"`
		AllowedReasoningEffort []string `json:"allowed_reasoning_effort"`
		DefaultReasoningEffort string   `json:"default_reasoning_effort"`
		IsDefault              bool     `json:"is_default"`
	} `json:"models"`
	ModelCatalogError json.RawMessage `json:"model_catalog_error"`
	Preferred         bool            `json:"preferred"`
}

type storedWorkspaceGrant struct {
	GrantID  string  `json:"grant_id"`
	TenantID string  `json:"tenant_id"`
	Scope    string  `json:"scope"`
	Label    *string `json:"label"`
	Mode     string  `json:"mode"`
}

// listOwnedLocalComputers projects the owner's Computers from what the Runner
// Gateway recorded at hello and heartbeat. An offline Computer keeps its last
// reported Runtimes and models so an Agent can be placed on it. A Computer
// without an owner-scoped workspace grant in this Tenant is not listed.
func listOwnedLocalComputers(ctx context.Context, queries *store.Queries, tenantID, ownerActorID string, now time.Time) ([]httpapi.LocalComputer, error) {
	rows, err := queries.ListOwnedLocalComputers(ctx, store.ListOwnedLocalComputersParams{TenantID: tenantID, OwnerActorID: ownerActorID})
	if err != nil {
		return nil, err
	}
	items := make([]httpapi.LocalComputer, 0, len(rows))
	for _, row := range rows {
		item, listed, err := projectStoredLocalComputer(row, tenantID, now)
		if err != nil {
			return nil, err
		}
		if listed {
			items = append(items, item)
		}
	}
	return items, nil
}

func projectStoredLocalComputer(row store.RuntimeLocalComputer, tenantID string, now time.Time) (httpapi.LocalComputer, bool, error) {
	item, listed, err := projectStoredLocalComputerWithGrants(row, tenantID, now, true)
	if err != nil || !listed {
		return httpapi.LocalComputer{}, false, err
	}
	return item, true, nil
}

// projectStoredLocalComputerForPlacement projects a Computer even when it has
// no owner-scoped workspace grant in tenantID yet, so Another Me placement
// diagnostics can distinguish a missing writable grant from an offline or
// unlisted Computer.
func projectStoredLocalComputerForPlacement(row store.RuntimeLocalComputer, tenantID string, now time.Time) (httpapi.LocalComputer, error) {
	item, _, err := projectStoredLocalComputerWithGrants(row, tenantID, now, false)
	return item, err
}

func projectStoredLocalComputerWithGrants(row store.RuntimeLocalComputer, tenantID string, now time.Time, requireGrant bool) (httpapi.LocalComputer, bool, error) {
	var storedGrants []storedWorkspaceGrant
	if err := json.Unmarshal(row.WorkspaceGrants, &storedGrants); err != nil {
		return httpapi.LocalComputer{}, false, err
	}
	grants := make([]httpapi.LocalComputerWorkspaceGrant, 0, len(storedGrants))
	for _, grant := range storedGrants {
		mode := httpapi.LocalComputerWorkspaceGrantMode(grant.Mode)
		if grant.TenantID != tenantID || grant.Scope != "owner" || !mode.Valid() {
			continue
		}
		label := grant.GrantID
		if grant.Label != nil {
			label = *grant.Label
		}
		grants = append(grants, httpapi.LocalComputerWorkspaceGrant{GrantId: grant.GrantID, Label: label, Mode: mode})
	}
	if requireGrant && len(grants) == 0 {
		return httpapi.LocalComputer{}, false, nil
	}
	slices.SortFunc(grants, func(left, right httpapi.LocalComputerWorkspaceGrant) int {
		return strings.Compare(left.GrantId, right.GrantId)
	})
	// A Gateway that stops without disconnecting leaves the row online; its
	// 20s heartbeat keeps a connected Computer inside the freshness window.
	online := row.Status == "online" && row.LastSeenAt.Valid &&
		!row.LastSeenAt.Time.After(now) && now.Sub(row.LastSeenAt.Time) <= LocalComputerObservationFreshness
	runtimes, err := projectStoredRuntimes(row.RuntimeDiagnostics)
	if err != nil {
		return httpapi.LocalComputer{}, false, err
	}
	item := httpapi.LocalComputer{
		ComputerId: row.ComputerID, DisplayName: row.DisplayName,
		Status:          httpapi.LocalComputerStatusOffline,
		UpgradeRequired: row.Status == "upgrade_required",
		Runtimes:        runtimes, WorkspaceGrants: grants,
	}
	if online {
		item.Status, item.ActiveOperations = httpapi.LocalComputerStatusOnline, int(row.ActiveOperations)
	}
	if row.Platform.Valid {
		platform := httpapi.LocalComputerPlatform(row.Platform.String)
		item.Platform = &platform
	}
	if row.DaemonVersion.Valid {
		item.DaemonVersion = &row.DaemonVersion.String
	}
	if row.RecommendedVersion.Valid {
		item.RecommendedVersion = &row.RecommendedVersion.String
	}
	if row.LastSeenAt.Valid {
		item.LastSeenAt = &row.LastSeenAt.Time
	}
	return item, len(grants) > 0, nil
}

func projectStoredRuntimes(raw []byte) ([]httpapi.LocalComputerRuntime, error) {
	active, err := agentruntimestate.ActiveLocalRuntimeDiagnostics(raw)
	if err != nil {
		return nil, err
	}
	var diagnostics []storedRuntimeDiagnostic
	if err := json.Unmarshal(active, &diagnostics); err != nil {
		return nil, err
	}
	runtimes := make([]httpapi.LocalComputerRuntime, 0, len(diagnostics))
	for _, diagnostic := range diagnostics {
		status := httpapi.LocalRuntimeDiagnosticStatus(diagnostic.Status)
		if !agentruntimestate.IsSupportedLocalRuntimeType(diagnostic.Type) || !status.Valid() {
			continue
		}
		runtime := httpapi.LocalComputerRuntime{
			Type: httpapi.LocalRuntimeType(diagnostic.Type), Status: status, Models: storedRuntimeModels(diagnostic),
		}
		if diagnostic.Version != "" {
			runtime.Version = &diagnostic.Version
		}
		if diagnostic.Error != nil {
			code := httpapi.LocalRuntimeDiagnosticErrorCode(diagnostic.Error.Code)
			if code.Valid() {
				runtime.ErrorCode = &code
			}
			if diagnostic.Error.Message != "" {
				runtime.Message = &diagnostic.Error.Message
			}
		}
		runtimes = append(runtimes, runtime)
	}
	slices.SortFunc(runtimes, func(left, right httpapi.LocalComputerRuntime) int {
		return strings.Compare(string(left.Type), string(right.Type))
	})
	return runtimes, nil
}

// storedPreferredRuntime is the Runtime the Computer reports as the one its
// person chose at installation, or "" when it reports none.
func storedPreferredRuntime(raw []byte) (string, error) {
	active, err := agentruntimestate.ActiveLocalRuntimeDiagnostics(raw)
	if err != nil {
		return "", err
	}
	var diagnostics []storedRuntimeDiagnostic
	if err := json.Unmarshal(active, &diagnostics); err != nil {
		return "", err
	}
	for _, diagnostic := range diagnostics {
		if diagnostic.Preferred {
			return diagnostic.Type, nil
		}
	}
	return "", nil
}

func isValidReasoningEffortToken(value string) bool {
	if len(value) == 0 || len(value) > 20 {
		return false
	}
	for i := 0; i < len(value); i++ {
		c := value[i]
		isAlphaNum := (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
		if i == 0 {
			if !isAlphaNum {
				return false
			}
			continue
		}
		if !isAlphaNum && c != '_' && c != '-' {
			return false
		}
	}
	return true
}

const maxRuntimeModelReasoningEfforts = 32

func storedRuntimeModels(diagnostic storedRuntimeDiagnostic) []httpapi.AgentModel {
	if len(diagnostic.ModelCatalogError) > 0 && string(diagnostic.ModelCatalogError) != "null" {
		return []httpapi.AgentModel{}
	}
	if diagnostic.Models == nil {
		return []httpapi.AgentModel{defaultLocalRuntimeModels[diagnostic.Type]}
	}
	models := make([]httpapi.AgentModel, 0, len(*diagnostic.Models))
	for _, stored := range *diagnostic.Models {
		model := httpapi.AgentModel{Id: stored.ID, Label: stored.Label}
		allowed := make([]httpapi.AgentReasoningEffort, 0, min(len(stored.AllowedReasoningEffort), maxRuntimeModelReasoningEfforts))
		for _, value := range stored.AllowedReasoningEffort {
			if len(allowed) >= maxRuntimeModelReasoningEfforts {
				break
			}
			if isValidReasoningEffortToken(value) && !slices.Contains(allowed, value) {
				allowed = append(allowed, value)
			}
		}
		if len(allowed) > 0 {
			model.AllowedReasoningEffort = &allowed
			if effort := resolveDefaultReasoningEffort(allowed, stored.DefaultReasoningEffort); effort != "" {
				model.DefaultReasoningEffort = &effort
			}
		}
		if stored.IsDefault {
			model.IsDefault = &stored.IsDefault
		}
		models = append(models, model)
	}
	return models
}

// resolveDefaultReasoningEffort picks preferred when allowed, else prefers
// medium -> low -> high -> first non-none -> first allowed.
func resolveDefaultReasoningEffort(allowed []httpapi.AgentReasoningEffort, preferred string) httpapi.AgentReasoningEffort {
	if len(allowed) == 0 {
		return ""
	}
	if preferred != "" && slices.Contains(allowed, preferred) {
		return preferred
	}
	for _, candidate := range []httpapi.AgentReasoningEffort{
		"medium",
		"low",
		"high",
	} {
		if slices.Contains(allowed, candidate) {
			return candidate
		}
	}
	for _, effort := range allowed {
		if effort != "none" {
			return effort
		}
	}
	return allowed[0]
}

// storedRuntimeModel looks up one advertised model in a Computer's recorded
// RuntimeDiagnostics for runtimeType, falling back to the default or first
// advertised model for legacy "<runtime>-default" aliases.
func storedRuntimeModel(raw []byte, runtimeType, modelID string) (httpapi.AgentModel, bool) {
	runtimes, err := projectStoredRuntimes(raw)
	if err != nil {
		return httpapi.AgentModel{}, false
	}
	for _, runtime := range runtimes {
		if string(runtime.Type) != runtimeType {
			continue
		}
		for _, model := range runtime.Models {
			if model.Id == modelID {
				return model, true
			}
		}
		if modelID == runtimeType+"-default" && len(runtime.Models) > 0 {
			for _, model := range runtime.Models {
				if model.IsDefault != nil && *model.IsDefault {
					return model, true
				}
			}
			return runtime.Models[0], true
		}
	}
	return httpapi.AgentModel{}, false
}

// resolveRegistrationReasoningEffort aligns a requested effort with the target
// Computer's projected model catalog: models without effort levels clear it,
// supported values are preserved, and missing or unsupported values clamp to
// the model's default effort.
func resolveRegistrationReasoningEffort(
	diagnostics []byte,
	runtimeType, modelID string,
	requested *httpapi.AgentReasoningEffort,
) *httpapi.AgentReasoningEffort {
	model, found := storedRuntimeModel(diagnostics, runtimeType, modelID)
	if !found {
		return requested
	}
	if model.AllowedReasoningEffort == nil || len(*model.AllowedReasoningEffort) == 0 {
		return nil
	}
	allowed := *model.AllowedReasoningEffort
	if requested != nil && slices.Contains(allowed, *requested) {
		return requested
	}
	if model.DefaultReasoningEffort != nil {
		resolved := *model.DefaultReasoningEffort
		return &resolved
	}
	resolved := allowed[0]
	return &resolved
}

// ListOwnedLocalComputers lists the Human's Computers as the Runner Gateway
// last recorded them.
func (s *Service) ListOwnedLocalComputers(ctx context.Context, tenantID, ownerActorID string) ([]httpapi.LocalComputer, error) {
	return listOwnedLocalComputers(ctx, s.queries, tenantID, ownerActorID, time.Now())
}

// CountComputerAgents counts the Agents placed on a Computer.
func (s *Service) CountComputerAgents(ctx context.Context, tenantID, computerID string) (int64, error) {
	return s.queries.CountLocalAgentRegistrationsByComputer(ctx, store.CountLocalAgentRegistrationsByComputerParams{
		TenantID: tenantID, ComputerID: computerID,
	})
}

// LocalComputerPlacement returns the Computer an Agent runs on and its
// owner, while the Agent's Sponsor still owns it. It reports pgx.ErrNoRows
// for an Agent that does not run on a Local Computer.
func (s *Service) LocalComputerPlacement(ctx context.Context, tenantID, agentActorID string) (string, string, error) {
	row, err := s.queries.GetAgentLocalComputerPlacement(ctx, store.GetAgentLocalComputerPlacementParams{
		ActorID: agentActorID, TenantID: tenantID,
	})
	return row.ComputerID, row.OwnerActorID, err
}
