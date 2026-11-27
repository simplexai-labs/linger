package provider

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
	localworkspace "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/workspace"
)

func probePiRuntime(ctx context.Context, executable string, environment map[string]string, timeout time.Duration) runtimeProbeOutcome {
	probeCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	prepared, envErr := localworkspace.PiSourceEnvironment(environment)
	probeEnv := prepared
	if envErr != nil {
		probeEnv = environment
	}
	probeResult, err := native.ProbePiProtocolAndModels(probeCtx, native.NewInvocation(executable, nil).WithEnvironment(probeEnv))
	if !probeResult.ProtocolVerified {
		logProbeExit("runner.runtime_probe.handshake_failed", "pi", err, probeResult.Stderr)
		if probeCtx.Err() != nil || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
			return runtimeProbeOutcome{Status: "error", Code: "RUNTIME_DIAGNOSTIC_FAILED", Message: "Runtime protocol handshake could not be completed within its deadline"}
		}
		return runtimeProbeOutcome{Status: "incompatible", Code: "RUNTIME_INCOMPATIBLE", Message: "Runtime protocol handshake failed"}
	}
	if envErr != nil {
		return runtimeProbeOutcome{Status: "error", Code: "RUNTIME_DIAGNOSTIC_FAILED", Message: "Pi authentication could not be verified", protocolVerified: true}
	}
	if err != nil {
		failure := runtimeProbeOutcome{Status: "error", Code: "RUNTIME_DIAGNOSTIC_FAILED", Message: "Pi authentication could not be verified", protocolVerified: true}
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(probeCtx.Err(), context.DeadlineExceeded) {
			failure.Message = "Pi model catalog timed out"
		}
		if errors.Is(err, context.Canceled) || errors.Is(probeCtx.Err(), context.Canceled) {
			failure.Message = "Pi model catalog was canceled"
		}
		return failure
	}
	outcome := checkPiModelAuthentication(probeCtx, executable, prepared, probeResult.Models, timeout)
	outcome.protocolVerified = true
	return outcome
}

func probePiAuthentication(ctx context.Context, executable string, environment map[string]string, timeout time.Duration, _ string) runtimeProbeOutcome {
	probeCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	failure := runtimeProbeOutcome{Status: "error", Code: "RUNTIME_DIAGNOSTIC_FAILED", Message: "Pi authentication could not be verified"}
	prepared, err := localworkspace.PiSourceEnvironment(environment)
	if err != nil {
		return failure
	}
	catalog, err := native.DiscoverPiModels(probeCtx, native.NewInvocation(executable, nil).WithEnvironment(prepared))
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(probeCtx.Err(), context.DeadlineExceeded) {
			failure.Message = "Pi model catalog timed out"
		}
		if errors.Is(err, context.Canceled) || errors.Is(probeCtx.Err(), context.Canceled) {
			failure.Message = "Pi model catalog was canceled"
		}
		return failure
	}
	return checkPiModelAuthentication(probeCtx, executable, prepared, catalog, timeout)
}

func checkPiModelAuthentication(ctx context.Context, executable string, prepared map[string]string, catalog native.ModelList, timeout time.Duration) runtimeProbeOutcome {
	failure := runtimeProbeOutcome{Status: "error", Code: "RUNTIME_DIAGNOSTIC_FAILED", Message: "Pi authentication could not be verified"}
	required := runtimeProbeOutcome{
		Status:  "authentication_required",
		Code:    "RUNTIME_AUTHENTICATION_REQUIRED",
		Message: "Configure a Pi API key or open pi and enter /login as the Computer user",
		catalog: &catalog,
	}
	if len(catalog.Models) == 0 {
		return required
	}
	model := catalog.Models[0].ID
	for _, candidate := range catalog.Models {
		if candidate.Default {
			model = candidate.ID
			break
		}
	}
	stdout, _, runErr := runBoundedProbe(ctx, executable, []string{"auth", "check", "--model", model, "--json"}, prepared, "", timeout)
	if errors.Is(runErr, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
		failure.Message = "Pi authentication check timed out"
		return failure
	}
	if errors.Is(runErr, context.Canceled) || errors.Is(ctx.Err(), context.Canceled) {
		failure.Message = "Pi authentication check was canceled"
		return failure
	}
	var status struct {
		Status string `json:"status"`
	}
	if json.Unmarshal([]byte(strings.TrimSpace(stdout)), &status) != nil {
		return failure
	}
	switch status.Status {
	case "ready":
		if runErr == nil {
			return runtimeProbeOutcome{Status: "ready", catalog: &catalog}
		}
	case "not_ready", "invalid":
		return required
	}
	return failure
}
