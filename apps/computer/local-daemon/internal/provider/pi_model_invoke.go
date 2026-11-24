package provider

import (
	"context"
	"errors"
	"os"
	"path/filepath"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
	localworkspace "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/workspace"
)

func invokePiModel(ctx context.Context, request ModelInvokeRequest, installed ModelInvokeRuntime, work, scratch string) ModelInvokeResult {
	if request.Mode == ModelInvokeWorkspace {
		return ModelInvokeResult{
			Outcome: ModelInvokeUnsupported,
			Reason:  "Pi background calls do not run file tools",
		}
	}
	environment, err := localworkspace.PiSourceEnvironment(modelInvokeEnvironment(installed.Environment, scratch))
	if err != nil {
		return ModelInvokeResult{Outcome: ModelInvokeRuntimeUnavailable, Reason: "Pi background profile is unavailable"}
	}
	instructions := request.Instructions
	if request.Mode == ModelInvokeStructured {
		instructions += "\n\nReturn only a JSON object matching this schema:\n" + string(request.OutputSchema)
	}
	instructionsFile := ""
	if instructions != "" {
		instructionsFile = filepath.Join(scratch, "instructions.md")
		if err := os.WriteFile(instructionsFile, []byte(instructions), 0o600); err != nil {
			return ModelInvokeResult{Outcome: ModelInvokeFailed, Reason: "Could not prepare Pi background instructions"}
		}
	}
	invokeCtx, cancel := context.WithTimeout(ctx, modelInvokeTimeout(request.Timeout))
	defer cancel()
	answer, model, err := native.InvokePiModel(
		invokeCtx, native.Profile{Program: installed.ExecutablePath, Env: environment},
		work, instructionsFile, request.Model, request.Input, request.ReasoningEffort,
	)
	switch {
	case invokeCtx.Err() != nil:
		return classifyModelInvokeFailure(ctx, invokeCtx, err, "", "")
	case err != nil || answer.Status != "completed" || !answer.ExitConfirmed:
		return classifyPiModelInvokeFailure(err, answer)
	case len(answer.Output) > ModelInvokeMaxTextBytes:
		return ModelInvokeResult{Outcome: ModelInvokeOutputLimited, Reason: "Pi background reply exceeds 1 MiB"}
	}
	result := ModelInvokeResult{Outcome: ModelInvokeCompleted, Text: answer.Output, Model: model}
	for _, count := range answer.Usage {
		if result.Usage == nil {
			result.Usage = &ModelInvokeUsage{}
		}
		result.Usage.InputTokens += count.Input
		result.Usage.OutputTokens += count.Output
		result.Usage.CachedInputTokens += count.CacheRead
	}
	return result
}

// classifyPiModelInvokeFailure maps Pi background call errors to sanitized
// structured outcomes without forwarding raw Pi messages that may contain
// provider URLs or credentials.
func classifyPiModelInvokeFailure(err error, answer native.Outcome) ModelInvokeResult {
	if errors.Is(err, native.ErrPiUnsupportedEffort) {
		return ModelInvokeResult{Outcome: ModelInvokeFailed, Reason: "Pi background reasoning effort is unsupported"}
	}
	if err != nil {
		return ModelInvokeResult{Outcome: ModelInvokeRuntimeUnavailable, Reason: "Pi background runtime failed to start"}
	}
	if apiErr, ok := parseStructuredAPIError(answer.Error); ok {
		if isContextTooLongErrorCode(apiErr.Code) || isContextTooLongErrorCode(apiErr.Type) {
			return ModelInvokeResult{Outcome: ModelInvokeContextTooLong, Reason: "Model invocation prompt exceeds the model context window"}
		}
		if apiErr.Code == "model_not_found" {
			return ModelInvokeResult{Outcome: ModelInvokeRuntimeIncompatible, Reason: "Pi background model is not available"}
		}
		if isAuthErrorCode(apiErr.Code) || isAuthErrorCode(apiErr.Type) {
			return ModelInvokeResult{Outcome: ModelInvokeAuthRequired, Reason: "Pi background authentication is required"}
		}
		if isUnavailableErrorCode(apiErr.Code) || isUnavailableErrorCode(apiErr.Type) {
			return ModelInvokeResult{Outcome: ModelInvokeRuntimeUnavailable, Reason: "Pi background model service is unavailable"}
		}
	}
	if posixNetworkErrnoPattern.MatchString(answer.Error) {
		return ModelInvokeResult{Outcome: ModelInvokeRuntimeUnavailable, Reason: "Pi background model service is unavailable"}
	}
	return ModelInvokeResult{Outcome: ModelInvokeFailed, Reason: "Pi background call did not complete"}
}
