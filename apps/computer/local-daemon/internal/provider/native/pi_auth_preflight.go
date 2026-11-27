package native

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

// checkModelAuthentication asks Pi whether this Run's selected model has
// credentials. The runtime-level probe can only validate its catalog default,
// while an explicit model can select another provider. A probe that cannot
// produce a definitive missing-credential answer is advisory only.
func (p *piRuntime) checkModelAuthentication(ctx context.Context, plan piLaunchPlan) error {
	model := plan.spec.Model
	if model == "" || model == piDefaultModel {
		return nil
	}

	checkCtx, cancel := context.WithTimeout(ctx, piAuthCheckTimeout)
	defer cancel()
	command := ownedCommand(
		checkCtx,
		profileInvocation(plan.program, nil, p.profile.Env),
		"auth", "check", "--model", model, "--json",
	)
	command.Dir = plan.spec.Dir
	// The helper output is the credential verdict; discard stderr so a
	// provider's diagnostic text cannot leak credentials into Daemon logs.
	command.Stderr = io.Discard
	stdout, runErr := runOutput(checkCtx, command)
	if ctx.Err() != nil {
		// The caller cancelled the Operation. That is not an inconclusive
		// credential verdict, so it must not be swallowed as advisory.
		return ctx.Err()
	}
	if runErr != nil && checkCtx.Err() != nil {
		// The probe's own budget ran out while the caller is still live. It
		// made no definitive claim about the credentials, even if it emitted
		// partial output before it stopped.
		p.profile.Logger.Warn("pi.auth_check_unavailable", "model", model, "error", runErr)
		return nil
	}

	var status struct {
		Status string `json:"status"`
		Reason string `json:"reason"`
	}
	parseErr := json.Unmarshal([]byte(strings.TrimSpace(string(stdout))), &status)
	if parseErr != nil {
		p.profile.Logger.Warn("pi.auth_check_unavailable", "model", model, "error", errors.Join(runErr, parseErr))
		return nil
	}
	switch status.Status {
	case "not_ready":
		if status.Reason == "provider_not_found" {
			// Pi does not know this provider, so nothing can be said about
			// credentials. Let the Run surface the real model error itself.
			p.profile.Logger.Warn("pi.auth_check_unavailable", "model", model, "reason", status.Reason)
			return nil
		}
		// `not_ready` is Pi's definitive "this provider has no credentials"
		// verdict (exit 1). `invalid` (exit 2) means Pi's own model runtime is
		// in a bad state, which says nothing about the user's credentials, so
		// it falls through to the advisory path below instead of blocking.
		return fmt.Errorf("%w: Pi model %q has no credentials on this Computer: configure the provider's API key as the Computer user or run pi /login", ErrPiModelAuthenticationRequired, model)
	case "ready":
		if runErr == nil {
			return nil
		}
	}
	p.profile.Logger.Warn("pi.auth_check_unavailable", "model", model, "status", status.Status, "error", runErr)
	return nil
}
