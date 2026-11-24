package provider

import (
	"context"
	"errors"
	"maps"
	"reflect"
	"time"

	localworkspace "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/workspace"
)

type RuntimeMonitorOptions struct {
	Initial   DiscoveryResult
	Discovery DiscoveryOptions
	// ResolveDiscovery returns the live DiscoveryOptions when Runtime profile
	// environments or executable paths can change without restarting the Daemon.
	ResolveDiscovery      func() DiscoveryOptions
	RefreshInterval       time.Duration
	FullRefreshEveryTicks int
	OnChanged             func(DiscoveryResult) error
	OnError               func(error)
	Discover              func(context.Context, DiscoveryOptions) (DiscoveryResult, error)
	// Shape projects each DiscoveryResult after full discovery or
	// authentication refresh (for example applying a persisted BYOK catalog
	// overlay) before diffing against current diagnostics or publishing.
	Shape func(DiscoveryResult) DiscoveryResult
	// RefreshAllowed reports whether periodic discovery and authentication
	// refreshes should run. Nil means allowed.
	RefreshAllowed     func() bool
	FullRefreshAllowed func() bool
	// RuntimeBusy reports an active operation. A running operation proves its
	// Runtime works, so an inconclusive auth probe then keeps the ready state.
	RuntimeBusy func() bool
	// Refresh asks for a full discovery before the next scheduled one, for
	// example after a local model load changed Pi's model list. The request
	// waits while FullRefreshAllowed is false.
	Refresh <-chan struct{}
	// InitialPublished is what the caller already published for Initial,
	// such as the hello's diagnostics; nil publishes Shape(Initial).
	InitialPublished *DiscoveryResult
}

const transientRuntimeFailureThreshold = 2

func MonitorRuntimeDiagnostics(ctx context.Context, options RuntimeMonitorOptions) error {
	if options.RefreshInterval <= 0 || options.FullRefreshEveryTicks < 1 || options.OnChanged == nil {
		return errors.New("Runtime diagnostic monitor options are invalid")
	}
	resolveDiscovery := func() DiscoveryOptions {
		if options.ResolveDiscovery != nil {
			return options.ResolveDiscovery()
		}
		return options.Discovery
	}
	// current is what discovery and the authentication probes found, the
	// input of the next probe and of the retain rules, which compare a
	// Runtime's own status and probe provenance. published is current after
	// Shape, which adds catalog entries and statuses no probe produced (a
	// BYOK catalog, the local models Pi lists only while loaded): it is what
	// OnChanged reports and what the next result is compared against.
	// Feeding a shaped result back into a probe would keep those entries
	// after the condition that added them is gone.
	shape := func(result DiscoveryResult) DiscoveryResult {
		if options.Shape == nil {
			return result
		}
		return options.Shape(result)
	}
	current := options.Initial
	published := shape(current)
	if options.InitialPublished != nil {
		published = *options.InitialPublished
	}
	activeDiscovery := resolveDiscovery()
	prevEnv := maps.Clone(activeDiscovery.Environment)
	prevPaths := maps.Clone(activeDiscovery.ConfiguredPaths)
	transientFailures := make(map[string]int)
	authenticationFailures := make(map[string]int)
	discover := options.Discover
	if discover == nil {
		discover = Discover
	}
	ticker := time.NewTicker(options.RefreshInterval)
	defer ticker.Stop()
	requested := false
	for tick := 0; ; {
		select {
		case <-ctx.Done():
			return context.Cause(ctx)
		case <-ticker.C:
			tick++
		case <-options.Refresh:
			requested = true
		}
		if options.RefreshAllowed != nil && !options.RefreshAllowed() {
			continue
		}
		activeDiscovery = resolveDiscovery()
		envChanged := !maps.Equal(prevEnv, activeDiscovery.Environment) || !maps.Equal(prevPaths, activeDiscovery.ConfiguredPaths)
		var next DiscoveryResult
		var err error
		if (requested || envChanged || tick%options.FullRefreshEveryTicks == 0 || runtimeExecutablesChanged(current.Diagnostics)) &&
			(options.FullRefreshAllowed == nil || options.FullRefreshAllowed()) {
			next, err = discover(ctx, activeDiscovery)
			if err == nil {
				requested = false
				prevEnv = maps.Clone(activeDiscovery.Environment)
				prevPaths = maps.Clone(activeDiscovery.ConfiguredPaths)
				for _, diagnostic := range next.Diagnostics {
					if diagnostic.Status == "ready" {
						delete(authenticationFailures, diagnostic.Type)
					}
				}
				next = retainReadyRuntimesDuringTransientFailures(current, published, next, transientFailures)
			}
		} else {
			next, err = refreshRuntimeAuthentication(ctx, current, activeDiscovery, tick%options.FullRefreshEveryTicks == 0)
			if err == nil {
				if options.RuntimeBusy != nil && options.RuntimeBusy() {
					next = retainReadyRuntimesDuringInconclusiveProbes(current, published, next)
				}
				next = retainReadyRuntimesDuringTransientFailures(current, published, next, authenticationFailures)
			}
		}
		if err != nil {
			if options.OnError != nil {
				options.OnError(err)
				continue
			}
			return err
		}
		shaped := shape(next)
		if !envChanged && sameRuntimeDiagnostics(published.Diagnostics, shaped.Diagnostics) {
			// Retain internal probe provenance even when the public status did not
			// change; only this provenance permits a safe auth-only recovery.
			current = next
			continue
		}
		if err := options.OnChanged(shaped); err != nil {
			if options.OnError != nil {
				options.OnError(err)
				continue
			}
			return err
		}
		current, published = next, shaped
	}
}

// publishedReady reports whether runtimeType was published ready. The
// retain rules restore the previous unshaped diagnostic but decide on what
// was published: a Shape can report a Runtime ready that its own probe did
// not (Pi made ready by the Computer's local models), and a failed probe of
// that Runtime must be retained just as one of a natively ready Runtime.
func publishedReady(current, published DiscoveryResult, runtimeType string) bool {
	for _, result := range []DiscoveryResult{current, published} {
		if previous := findRuntimeDiagnostic(result.Diagnostics, runtimeType); previous != nil && previous.Status == "ready" {
			return true
		}
	}
	return false
}

func retainReadyRuntimesDuringTransientFailures(current, published, next DiscoveryResult, failures map[string]int) DiscoveryResult {
	diagnostics := append([]RuntimeDiagnostic(nil), next.Diagnostics...)
	for index := range diagnostics {
		previous := findRuntimeDiagnostic(current.Diagnostics, diagnostics[index].Type)
		if previous == nil {
			continue
		}
		if publishedReady(current, published, diagnostics[index].Type) && !runtimeExecutableChanged(*previous) && previous.ExecutablePath == diagnostics[index].ExecutablePath &&
			(diagnostics[index].Status == "incompatible" || diagnostics[index].Status == "error") &&
			(diagnostics[index].Type != "codex" || diagnostics[index].ModelCatalogError == "") {
			failures[diagnostics[index].Type]++
			if failures[diagnostics[index].Type] < transientRuntimeFailureThreshold {
				diagnostics[index] = *previous
				continue
			}
		} else {
			delete(failures, diagnostics[index].Type)
		}
	}
	return DiscoveryResult{Diagnostics: diagnostics, Installations: InstallationsFromDiagnostics(diagnostics)}
}

// retainReadyRuntimesDuringInconclusiveProbes keeps a ready Runtime ready
// when its auth probe neither succeeded nor reported a logout, which a busy
// machine causes by timing the probe out. A real logout still goes through.
func retainReadyRuntimesDuringInconclusiveProbes(current, published, next DiscoveryResult) DiscoveryResult {
	diagnostics := append([]RuntimeDiagnostic(nil), next.Diagnostics...)
	changed := false
	for index := range diagnostics {
		previous := findRuntimeDiagnostic(current.Diagnostics, diagnostics[index].Type)
		if previous == nil || !publishedReady(current, published, diagnostics[index].Type) || !diagnostics[index].authProbeFailed {
			continue
		}
		diagnostics[index] = *previous
		changed = true
	}
	if !changed {
		return next
	}
	return DiscoveryResult{Diagnostics: diagnostics, Installations: InstallationsFromDiagnostics(diagnostics)}
}

func findRuntimeDiagnostic(diagnostics []RuntimeDiagnostic, runtimeType string) *RuntimeDiagnostic {
	for index := range diagnostics {
		if diagnostics[index].Type == runtimeType {
			return &diagnostics[index]
		}
	}
	return nil
}

func RefreshRuntimeAuthentication(ctx context.Context, current DiscoveryResult, options DiscoveryOptions) (DiscoveryResult, error) {
	return refreshRuntimeAuthentication(ctx, current, options, false)
}

// A full discovery cannot run during an active operation. Retry only previously
// verified executables whose authentication probe failed, at the slower full
// discovery cadence, so a transient error can recover without restarting.
func refreshRuntimeAuthentication(ctx context.Context, current DiscoveryResult, options DiscoveryOptions, retryFailed bool) (DiscoveryResult, error) {
	diagnostics := append([]RuntimeDiagnostic(nil), current.Diagnostics...)
	for index := range diagnostics {
		if err := ctx.Err(); err != nil {
			return DiscoveryResult{}, context.Cause(ctx)
		}
		diagnostic := diagnostics[index]
		if runtimeExecutableChanged(diagnostic) {
			// Active operations keep their process. Only full discovery can
			// validate a replacement executable, never an auth-only probe.
			continue
		}
		if (diagnostic.Type == "codex" || diagnostic.Type == "pi" || diagnostic.Type == "antigravity") && diagnostic.Status == "error" && diagnostic.ModelCatalogError != "" {
			continue
		}
		if diagnostic.ExecutablePath == "" || (diagnostic.Status != "ready" && diagnostic.Status != "authentication_required" &&
			!(retryFailed && diagnostic.Status == "error" && diagnostic.Version != "" && diagnostic.authProbeFailed && diagnostic.Error != nil && diagnostic.Error.Code == "RUNTIME_DIAGNOSTIC_FAILED")) {
			continue
		}
		policy := runtimeDetectionPolicies[diagnostic.Type]
		if !policy.authenticationRefresh || policy.authenticationProbe == nil {
			continue
		}
		environment := maps.Clone(options.Environment)
		if diagnostic.ExecutionPath != "" {
			if environment == nil {
				environment = make(map[string]string)
			}
			environment["PATH"] = diagnostic.ExecutionPath
		}
		outcome := refreshAuthenticationProbe(ctx, diagnostic, environment, options)
		diagnostic.Status = outcome.Status
		diagnostic.authProbeFailed = outcome.Status == "error" && outcome.Code == "RUNTIME_DIAGNOSTIC_FAILED"
		diagnostic.CheckedAt = time.Now().UTC()
		if outcome.Status == "ready" {
			diagnostic.Error = nil
		} else {
			diagnostic.Error = &DiagnosticError{Code: outcome.Code, Message: outcome.Message}
		}
		if (diagnostic.Type == "pi" || diagnostic.Type == "antigravity") && diagnostic.Status == "ready" {
			previousModels := diagnostic.Models
			catalogCtx, cancel := context.WithTimeout(ctx, boundedAuthTimeout(options.Timeout))
			diagnostic.Models, diagnostic.ModelCatalogError = probedRuntimeModels(catalogCtx, diagnostic.Type, diagnostic.ExecutablePath, environment, outcome)
			if diagnostic.ModelCatalogError == "" {
				carryOrResolveModelLinks(catalogCtx, diagnostic.Type, environment, previousModels, diagnostic.Models)
			}
			cancel()
			if diagnostic.ModelCatalogError != "" {
				diagnostic.Status, diagnostic.authProbeFailed = "error", false
				diagnostic.Error = &DiagnosticError{Code: "RUNTIME_DIAGNOSTIC_FAILED", Message: diagnostic.ModelCatalogError}
			}
		}
		diagnostics[index] = diagnostic
	}
	return DiscoveryResult{Diagnostics: diagnostics, Installations: InstallationsFromDiagnostics(diagnostics)}, nil
}

// carryOrResolveModelLinks reuses Link and ContextWindow from previousModels by
// ID so steady-state authentication refreshes do not re-query a gateway's
// /models endpoint every tick, while newly observed models (such as after
// recovering from authentication_required) still resolve their link and window.
func carryOrResolveModelLinks(ctx context.Context, kind string, environment map[string]string, previousModels, models []RuntimeModel) {
	known := make(map[string]RuntimeModel, len(previousModels))
	for _, model := range previousModels {
		if model.Link != "" {
			known[model.ID] = model
		}
	}
	var getModelLink func(RuntimeModel) modelLink
	for i := range models {
		if prev, ok := known[models[i].ID]; ok {
			models[i].Link = prev.Link
			if prev.ContextWindow > 0 {
				models[i].ContextWindow = prev.ContextWindow
			}
			continue
		}
		if getModelLink == nil {
			getModelLink = newGetModelLink(ctx, kind, environment)
		}
		link := getModelLink(models[i])
		models[i].Link, models[i].ContextWindow = link.link, link.window
	}
}

func refreshAuthenticationProbe(ctx context.Context, diagnostic RuntimeDiagnostic, environment map[string]string, options DiscoveryOptions) runtimeProbeOutcome {
	budget := boundedAuthTimeout(options.Timeout)
	if diagnostic.Type != "codex" {
		return probeRuntimeAuthentication(ctx, diagnostic.Type, diagnostic.ExecutablePath, environment, budget, options.RuntimeHomeRoot)
	}
	probe, cancel := context.WithTimeout(ctx, budget)
	defer cancel()
	// An authentication probe lists no models, so its home needs no cache.
	prepared, release, err := localworkspace.CodexProbeEnvironment(probe, environment, diagnostic.Version, nil)
	if err != nil {
		return runtimeProbeOutcome{Status: "error", Code: "RUNTIME_DIAGNOSTIC_FAILED", Message: "Codex diagnostic home could not be prepared"}
	}
	defer release()
	return probeRuntimeAuthentication(probe, diagnostic.Type, diagnostic.ExecutablePath, prepared, budget, options.RuntimeHomeRoot)
}

func runtimeExecutableChanged(diagnostic RuntimeDiagnostic) bool {
	return diagnostic.EntryPath != "" && diagnostic.ExecutablePath != "" &&
		ValidateRuntimeExecutable(diagnostic.EntryPath, diagnostic.ExecutablePath) != nil
}

func runtimeExecutablesChanged(diagnostics []RuntimeDiagnostic) bool {
	for _, diagnostic := range diagnostics {
		if (diagnostic.Status == "ready" || diagnostic.Status == "authentication_required") && runtimeExecutableChanged(diagnostic) {
			return true
		}
	}
	return false
}

// InstallationsFromDiagnostics indexes ready and authentication-required
// Runtimes with a resolved executable path by Runtime type.
func InstallationsFromDiagnostics(diagnostics []RuntimeDiagnostic) map[string]RuntimeDiagnostic {
	installations := make(map[string]RuntimeDiagnostic)
	for _, diagnostic := range diagnostics {
		if diagnostic.ExecutablePath != "" && (diagnostic.Status == "ready" || diagnostic.Status == "authentication_required") {
			installations[diagnostic.Type] = diagnostic
		}
	}
	return installations
}

func sameRuntimeDiagnostics(left, right []RuntimeDiagnostic) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index].Type != right[index].Type || left[index].Status != right[index].Status ||
			left[index].ModelCatalogError != right[index].ModelCatalogError || !reflect.DeepEqual(left[index].Models, right[index].Models) ||
			left[index].Protocol != right[index].Protocol || left[index].Version != right[index].Version ||
			left[index].EntryPath != right[index].EntryPath || left[index].ExecutionPath != right[index].ExecutionPath ||
			left[index].ExecutablePath != right[index].ExecutablePath || !sameDiagnosticError(left[index].Error, right[index].Error) {
			return false
		}
	}
	return true
}

func sameDiagnosticError(left, right *DiagnosticError) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return left.Code == right.Code && left.Message == right.Message
}
