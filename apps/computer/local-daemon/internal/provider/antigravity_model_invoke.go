package provider

import (
	"context"
	"strings"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/redact"
)

func invokeAntigravityModel(
	ctx context.Context,
	request ModelInvokeRequest,
	installed ModelInvokeRuntime,
	work, scratch string,
) ModelInvokeResult {
	if request.Mode == ModelInvokeWorkspace {
		return ModelInvokeResult{
			Outcome: ModelInvokeUnsupported,
			Reason:  "Antigravity background calls do not run file tools",
		}
	}
	environment := modelInvokeEnvironment(installed.Environment, scratch)
	instructions := structuredModelInvokeInstructions(request)
	invokeCtx, cancel := context.WithTimeout(ctx, modelInvokeTimeout(request.Timeout))
	defer cancel()
	answer, model, err := native.InvokeAntigravityModel(
		invokeCtx,
		native.Profile{Program: installed.ExecutablePath, Env: environment},
		work,
		scratch,
		instructions,
		request.Model,
		request.Input,
		request.ReasoningEffort,
	)
	switch {
	case invokeCtx.Err() != nil:
		return classifyModelInvokeFailure(ctx, invokeCtx, err, "", "")
	case err != nil || answer.Status != "completed" || !answer.ExitConfirmed:
		return classifyAntigravityModelInvokeFailure(err, answer)
	case len(answer.Output) > ModelInvokeMaxTextBytes:
		return ModelInvokeResult{Outcome: ModelInvokeOutputLimited, Reason: "Antigravity background reply exceeds 1 MiB"}
	case strings.TrimSpace(answer.Output) == "":
		return ModelInvokeResult{Outcome: ModelInvokeFailed, Reason: "Runtime exited without a reply"}
	}
	result := ModelInvokeResult{Outcome: ModelInvokeCompleted, Text: answer.Output, Model: model}
	for _, count := range answer.Usage {
		if result.Usage == nil {
			result.Usage = &ModelInvokeUsage{}
		}
		result.Usage.InputTokens += count.Input + count.CacheRead + count.CacheWrite
		result.Usage.CachedInputTokens += count.CacheRead
		result.Usage.OutputTokens += count.Output
	}
	return result
}

func classifyAntigravityModelInvokeFailure(err error, answer native.Outcome) ModelInvokeResult {
	if err == nil {
		switch answer.FailureCode {
		case "authentication_required":
			return ModelInvokeResult{Outcome: ModelInvokeAuthRequired, Reason: "Antigravity sign-in is required"}
		case "model_not_offered", "protocol_incompatible":
			reason := truncateRunes(redact.Text(strings.TrimSpace(answer.Error)), 300)
			if reason == "" {
				reason = "Antigravity background model is not available"
			}
			return ModelInvokeResult{Outcome: ModelInvokeRuntimeIncompatible, Reason: reason}
		case "context_too_long":
			return ModelInvokeResult{Outcome: ModelInvokeContextTooLong, Reason: "Model invocation prompt exceeds the model context window"}
		}
	}
	return classifyNativeModelInvokeFailure("Antigravity", err, answer, true)
}
