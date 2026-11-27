package provider

import (
	"context"
	"errors"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

// probeAntigravityAuthentication opens an empty ACP session: Antigravity
// answers session/new with ACP's authentication-required error when neither
// a Google sign-in nor a Gemini API key is available.
func probeAntigravityAuthentication(ctx context.Context, executable string, environment map[string]string, timeout time.Duration, _ string) runtimeProbeOutcome {
	ctx, cancel := context.WithTimeout(ctx, boundedAuthTimeout(timeout))
	defer cancel()
	probe, err := native.ProbeAntigravity(ctx, native.NewInvocation(executable, nil).WithEnvironment(environment))
	if err != nil {
		message := "Antigravity authentication could not be verified"
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			message = "Antigravity authentication check timed out"
		}
		return runtimeProbeOutcome{Status: "error", Code: "RUNTIME_DIAGNOSTIC_FAILED", Message: message}
	}
	if probe.AuthenticationRequired {
		return runtimeProbeOutcome{Status: "authentication_required", Code: "RUNTIME_AUTHENTICATION_REQUIRED", Message: "Open agy and sign in with Google, or set GEMINI_API_KEY, as the Computer user"}
	}
	return runtimeProbeOutcome{Status: "ready", catalog: &probe.Models}
}

// antigravityLiveReply runs the live-check prompt as one ACP turn in HOME.
func antigravityLiveReply(ctx context.Context, executable string, environment map[string]string, timeout time.Duration) (string, error) {
	backend, err := native.Open("antigravity", native.Profile{Program: executable, Env: environment})
	if err != nil {
		return "", err
	}
	run, err := backend.Start(ctx, liveCheckPrompt, native.RunSpec{Dir: environment["HOME"], Budget: timeout})
	if err != nil {
		return "", err
	}
	for range run.Events {
	}
	outcome, ok := <-run.Outcome
	if !ok {
		return "", errors.New("Antigravity live check ended without a result")
	}
	if outcome.Status != "completed" {
		return "", errors.New(outcome.Error)
	}
	return outcome.Output, nil
}
