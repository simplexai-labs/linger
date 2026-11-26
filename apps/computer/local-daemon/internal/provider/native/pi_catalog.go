package native

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

var (
	errPiNoModels             = errors.New("Pi returned no available models")
	errPiProtocolIncompatible = errors.New("Pi protocol handshake failed")
)

// PiProbeResult holds the outcome of a single-session Pi RPC handshake
// and model catalog query.
type PiProbeResult struct {
	ProtocolVerified bool
	Models           ModelList
	Stderr           string
}

// PiRPCResourceArgs is the resource policy shared by managed execution,
// managed catalog discovery and the protocol probe. It returns a new slice.
// systemPrompt, a file path or text, replaces Pi's built-in prompt, which
// describes a coding assistant, lists its tools and points at Pi's own docs.
// An empty one keeps the built-in prompt. Both prompt flags are passed even
// when empty: without them, Pi reads the user's SYSTEM.md and
// APPEND_SYSTEM.md from its agent folder.
func PiRPCResourceArgs(systemPrompt string) []string {
	return []string{"--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-approve",
		"--system-prompt", systemPrompt, "--append-system-prompt", ""}
}

type piCatalogState struct {
	Model         piCatalogModel `json:"model"`
	ThinkingLevel string         `json:"thinkingLevel"`
}

type piCatalogModel struct {
	ID               string                     `json:"id"`
	Name             string                     `json:"name"`
	Provider         string                     `json:"provider"`
	Reasoning        bool                       `json:"reasoning"`
	ThinkingLevelMap map[string]json.RawMessage `json:"thinkingLevelMap"`
	ContextWindow    json.RawMessage            `json:"contextWindow"`
}

// piThinkingLevels are Pi's levels in catalog order. Optional levels are
// offered only when the model maps them to a non-null value.
var piThinkingLevels = []struct {
	value    string
	optional bool
}{
	{"off", false}, {"minimal", false}, {"low", false}, {"medium", false}, {"high", false},
	{"xhigh", true}, {"max", true},
}

// DiscoverPiModels lists the models managed Pi execution can use. It runs
// Pi under the same resource policy as execution, so no extension can add
// models a managed run would not see.
func DiscoverPiModels(ctx context.Context, invocation Invocation) (ModelList, error) {
	program, err := exec.LookPath(invocation.Program)
	if err != nil {
		return ModelList{}, err
	}
	invocation.Program = program
	args := append([]string{"--mode", "rpc", "--no-session"}, PiRPCResourceArgs("")...)
	requests := []any{
		map[string]string{"id": "linger-state", "type": "get_state"},
		map[string]string{"id": "linger-models", "type": "get_available_models"},
	}
	expected := map[string]string{"linger-state": "get_state", "linger-models": "get_available_models"}
	replies := map[string]json.RawMessage{}
	receive := func(frame []byte, _ func(...any) error) (bool, error) {
		reply, isReply := piCatalogReplyFrame(frame)
		if !isReply {
			return false, nil
		}
		command, ok := expected[reply.ID]
		if !ok {
			return false, nil
		}
		if reply.Command != command || !reply.Success {
			return false, errPiNoModels
		}
		replies[reply.ID] = reply.Data
		return len(replies) == len(expected), nil
	}
	if err := exchangeCatalog(ctx, invocation, args, requests, receive); err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return ModelList{}, context.DeadlineExceeded
		}
		if errors.Is(err, context.Canceled) || errors.Is(ctx.Err(), context.Canceled) {
			return ModelList{}, context.Canceled
		}
		return ModelList{}, errPiNoModels
	}
	var state piCatalogState
	var available struct {
		Models []json.RawMessage `json:"models"`
	}
	if json.Unmarshal(replies["linger-state"], &state) != nil || json.Unmarshal(replies["linger-models"], &available) != nil {
		return ModelList{}, errPiNoModels
	}
	return piCatalogList(state, available.Models)
}

// ProbePiProtocolAndModels verifies the Pi RPC protocol handshake and queries
// the model catalog in a single Pi RPC process.
func ProbePiProtocolAndModels(ctx context.Context, invocation Invocation) (PiProbeResult, error) {
	program, err := exec.LookPath(invocation.Program)
	if err != nil {
		return PiProbeResult{}, err
	}
	invocation.Program = program
	args := append([]string{"--mode", "rpc", "--no-session"}, PiRPCResourceArgs("")...)
	requests := []any{
		map[string]string{"id": "linger-probe", "type": "get_state"},
		map[string]string{"id": "linger-models", "type": "get_available_models"},
	}
	var (
		protocolVerified bool
		needLegacyState  bool
		modelsFailed     bool
		stateReceived    bool
		modelsReceived   bool
		stateRaw         json.RawMessage
		modelsRaw        json.RawMessage
	)
	receive := func(frame []byte, send func(...any) error) (bool, error) {
		reply, isReply := piCatalogReplyFrame(frame)
		if !isReply {
			return false, nil
		}
		switch reply.ID {
		case "linger-probe":
			if protocolVerified {
				return false, nil
			}
			if reply.Command != "get_state" || !reply.Success {
				return false, errPiProtocolIncompatible
			}
			var data map[string]any
			if json.Unmarshal(reply.Data, &data) != nil {
				return false, errPiProtocolIncompatible
			}
			if _, streaming := data["isStreaming"].(bool); !streaming {
				return false, errPiProtocolIncompatible
			}
			protocolVerified = true
			_, hasModel := data["model"]
			_, hasThinking := data["thinkingLevel"]
			if hasModel || hasThinking {
				stateRaw = reply.Data
				stateReceived = true
			} else if !modelsFailed {
				needLegacyState = true
				if err := send(map[string]string{"id": "linger-state", "type": "get_state"}); err != nil {
					modelsFailed = true
				}
			}
		case "linger-state":
			if !needLegacyState {
				return false, nil
			}
			if reply.Command != "get_state" || !reply.Success {
				modelsFailed = true
			} else {
				stateRaw = reply.Data
				stateReceived = true
			}
		case "linger-models":
			if reply.Command != "get_available_models" || !reply.Success {
				modelsFailed = true
			} else {
				modelsRaw = reply.Data
				modelsReceived = true
			}
		default:
			return false, nil
		}
		if protocolVerified {
			if modelsFailed {
				return false, errPiNoModels
			}
			if stateReceived && modelsReceived {
				return true, nil
			}
		}
		return false, nil
	}
	if err := exchangeCatalog(ctx, invocation, args, requests, receive); err != nil {
		var exchangeErr *catalogExchangeError
		stderr := ""
		if errors.As(err, &exchangeErr) {
			stderr = exchangeErr.stderr
		}
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return PiProbeResult{ProtocolVerified: protocolVerified, Stderr: stderr}, context.DeadlineExceeded
		}
		if errors.Is(err, context.Canceled) || errors.Is(ctx.Err(), context.Canceled) {
			return PiProbeResult{ProtocolVerified: protocolVerified, Stderr: stderr}, context.Canceled
		}
		if !protocolVerified {
			if errors.Is(err, errPiProtocolIncompatible) {
				return PiProbeResult{Stderr: stderr}, err
			}
			return PiProbeResult{Stderr: stderr}, fmt.Errorf("%w: %w", errPiProtocolIncompatible, err)
		}
		return PiProbeResult{ProtocolVerified: true, Stderr: stderr}, errPiNoModels
	}
	if !protocolVerified {
		return PiProbeResult{}, errPiProtocolIncompatible
	}
	var state piCatalogState
	var available struct {
		Models []json.RawMessage `json:"models"`
	}
	if json.Unmarshal(stateRaw, &state) != nil || json.Unmarshal(modelsRaw, &available) != nil {
		return PiProbeResult{ProtocolVerified: true}, errPiNoModels
	}
	list, err := piCatalogList(state, available.Models)
	if err != nil {
		return PiProbeResult{ProtocolVerified: true}, err
	}
	return PiProbeResult{ProtocolVerified: true, Models: list}, nil
}

// piCatalogReplyFrame reports whether frame is a command response. Events
// and other lines are skipped by the catalog exchange.
func piCatalogReplyFrame(frame []byte) (piReplyFrame, bool) {
	var reply piReplyFrame
	if json.Unmarshal(frame, &reply) != nil {
		return reply, false
	}
	return reply, reply.Type == "response"
}

func piCatalogList(state piCatalogState, entries []json.RawMessage) (ModelList, error) {
	defaultKey := ""
	if provider, id := strings.TrimSpace(state.Model.Provider), strings.TrimSpace(state.Model.ID); provider != "" && id != "" {
		defaultKey = provider + "/" + id
	}
	var models catalogModels
	// How many listed models carry each name label.
	named := map[string]int{}
	for _, raw := range entries {
		var entry piCatalogModel
		if json.Unmarshal(raw, &entry) != nil {
			return ModelList{}, errPiNoModels
		}
		provider, id := strings.TrimSpace(entry.Provider), strings.TrimSpace(entry.ID)
		if provider == "" || id == "" {
			continue
		}
		key := provider + "/" + id
		option := ModelOption{ID: key, Label: key, Provider: provider, Default: key == defaultKey}
		// A model ID can be a routing alias or a long library path; the label
		// is the name Pi gives it, while the ID keeps selecting the same entry.
		nameLabel := false
		if name := strings.TrimSpace(entry.Name); name != "" && name != id && name != key {
			option.Label = name
			nameLabel = true
		}
		// A window that is not a whole token count stays unknown.
		if window, err := strconv.Atoi(strings.TrimSpace(string(entry.ContextWindow))); err == nil && window > 0 {
			option.ContextWindow = window
		}
		if entry.Reasoning {
			defaultLevel := ""
			if option.Default {
				defaultLevel = state.ThinkingLevel
			}
			option.Effort = piEffortSupport(entry.ThinkingLevelMap, defaultLevel)
		}
		if models.add(option) && nameLabel {
			named[option.Label]++
		}
	}
	list := models.list()
	// Models that share a name are told apart by their provider/id.
	for i := range list.Models {
		if named[list.Models[i].Label] > 1 {
			list.Models[i].Label += " (" + list.Models[i].ID + ")"
		}
	}
	if list.Models == nil {
		list.Models = []ModelOption{}
	}
	return list, nil
}

func piEffortSupport(levels map[string]json.RawMessage, defaultLevel string) *EffortSupport {
	var efforts effortCatalog
	for _, level := range piThinkingLevels {
		mapped, present := levels[level.value]
		null := present && bytes.Equal(bytes.TrimSpace(mapped), []byte("null"))
		if level.optional && (!present || null) || !level.optional && null {
			continue
		}
		efforts.add(level.value, "")
	}
	return finalizeEffortSupport(efforts, defaultLevel)
}
