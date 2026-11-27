package agentregistry

import (
	"fmt"
	"slices"
	"strings"

	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

const (
	maxPlacementBlockerRuntimes = 16
	maxPlacementBlockerMessage  = 512
)

type anotherMeLocalPlacement struct {
	ComputerID       string
	RuntimeType      string
	WorkspaceGrantID string
	Model            string
	ReasoningEffort  string
}

// evaluateAnotherMeLocalPlacement chooses where a new Another Me runs: the
// first online Computer with any ready Runtime, its first writable workspace
// grant, and the model that Runtime runs by default, else the first it
// reports. The preferred Runtime, the one the person chose at installation,
// goes first while it is ready. Otherwise it returns the most actionable
// placement blocker across computers, or nil when computers is empty.
func evaluateAnotherMeLocalPlacement(computers []httpapi.LocalComputer, preferredRuntime string) (anotherMeLocalPlacement, *httpapi.AnotherMePlacementBlocker) {
	var bestBlocker *httpapi.AnotherMePlacementBlocker
	bestRank := 0
	for _, computer := range computers {
		grantID := writableWorkspaceGrant(computer.WorkspaceGrants)
		if computer.Status == httpapi.LocalComputerStatusOnline && !computer.UpgradeRequired && grantID != "" {
			runtimes := computer.Runtimes
			if index := slices.IndexFunc(runtimes, func(runtime httpapi.LocalComputerRuntime) bool {
				return string(runtime.Type) == preferredRuntime
			}); index > 0 {
				runtimes = slices.Concat(runtimes[index:index+1], runtimes[:index], runtimes[index+1:])
			}
			for _, runtime := range runtimes {
				if runtime.Status != httpapi.LocalRuntimeDiagnosticStatusReady || len(runtime.Models) == 0 {
					continue
				}
				model := runtime.Models[0]
				if index := slices.IndexFunc(runtime.Models, func(candidate httpapi.AgentModel) bool {
					return candidate.IsDefault != nil && *candidate.IsDefault
				}); index >= 0 {
					model = runtime.Models[index]
				}
				return anotherMeLocalPlacement{
					ComputerID: computer.ComputerId, RuntimeType: string(runtime.Type), WorkspaceGrantID: grantID,
					Model: model.Id, ReasoningEffort: placementReasoningEffort(model),
				}, nil
			}
		}
		blocker, rank := classifyComputerPlacementBlocker(computer)
		if rank > bestRank {
			bestBlocker = blocker
			bestRank = rank
		}
	}
	return anotherMeLocalPlacement{}, bestBlocker
}

// classifyComputerPlacementBlocker explains why one Computer cannot host a new
// Another Me and ranks how close it is to ready so multi-Computer diagnostics
// report the furthest-along candidate.
func classifyComputerPlacementBlocker(computer httpapi.LocalComputer) (*httpapi.AnotherMePlacementBlocker, int) {
	blocker := &httpapi.AnotherMePlacementBlocker{}
	if computer.ComputerId != "" {
		computerID := computer.ComputerId
		blocker.ComputerId = &computerID
	}
	switch {
	case computer.UpgradeRequired:
		blocker.Reason = httpapi.ComputerUpgradeRequired
		return blocker, 2
	case computer.Status != httpapi.LocalComputerStatusOnline:
		blocker.Reason = httpapi.NoOnlineComputer
		return blocker, 1
	case writableWorkspaceGrant(computer.WorkspaceGrants) == "":
		blocker.Reason = httpapi.NoWritableWorkspaceGrant
		return blocker, 3
	default:
		blocker.Reason = httpapi.NoReadyRuntimeWithModels
		if summaries := summarizePlacementRuntimes(computer.Runtimes); len(summaries) > 0 {
			blocker.Runtimes = &summaries
		}
		return blocker, 4
	}
}

func summarizePlacementRuntimes(runtimes []httpapi.LocalComputerRuntime) []httpapi.AnotherMePlacementRuntimeStatus {
	if len(runtimes) == 0 {
		return nil
	}
	limit := min(len(runtimes), maxPlacementBlockerRuntimes)
	summaries := make([]httpapi.AnotherMePlacementRuntimeStatus, 0, limit)
	for _, runtime := range runtimes[:limit] {
		modelCount := 0
		if runtime.Status == httpapi.LocalRuntimeDiagnosticStatusReady {
			modelCount = len(runtime.Models)
		}
		summary := httpapi.AnotherMePlacementRuntimeStatus{
			Type:       runtime.Type,
			Status:     runtime.Status,
			ModelCount: modelCount,
		}
		if runtime.Message != nil {
			if message := truncatePlacementMessage(*runtime.Message); message != "" {
				summary.Message = &message
			}
		}
		summaries = append(summaries, summary)
	}
	return summaries
}

func truncatePlacementMessage(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	runes := []rune(trimmed)
	if len(runes) <= maxPlacementBlockerMessage {
		return trimmed
	}
	return string(runes[:maxPlacementBlockerMessage-1]) + "…"
}

func formatPlacementRuntimesForLog(runtimes *[]httpapi.AnotherMePlacementRuntimeStatus) []string {
	if runtimes == nil || len(*runtimes) == 0 {
		return nil
	}
	formatted := make([]string, 0, len(*runtimes))
	for _, runtime := range *runtimes {
		entry := fmt.Sprintf("%s:%s:%d", runtime.Type, runtime.Status, runtime.ModelCount)
		if runtime.Message != nil && *runtime.Message != "" {
			entry += ":" + *runtime.Message
		}
		formatted = append(formatted, entry)
	}
	return formatted
}

// placementReasoningEffort keeps the model default and otherwise takes the
// first allowed effort, because a model that offers efforts needs one.
func placementReasoningEffort(model httpapi.AgentModel) string {
	if model.DefaultReasoningEffort != nil {
		return *model.DefaultReasoningEffort
	}
	if model.AllowedReasoningEffort == nil || len(*model.AllowedReasoningEffort) == 0 {
		return ""
	}
	return (*model.AllowedReasoningEffort)[0]
}

func writableWorkspaceGrant(grants []httpapi.LocalComputerWorkspaceGrant) string {
	for _, grant := range grants {
		if grant.Mode == httpapi.WorkspaceWrite {
			return grant.GrantId
		}
	}
	return ""
}
