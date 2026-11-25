package computercli

import (
	"context"
	"errors"
	"slices"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/computerconfig"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
)

// runtimeDiagnostic is one Runtime as login, doctor and runtime check see it.
type runtimeDiagnostic struct {
	Type, Status string
	// ExecutablePath and EntryPath are empty when no installation was found.
	ExecutablePath, EntryPath string
	Available                 bool
	Version                   string
	ErrorMessage              string
}

type runtimeCheck struct {
	diagnostic runtimeDiagnostic
	// live is set only for a ready Runtime checked with a model reply.
	live *provider.LiveCheck
}

type runtimeRequest struct {
	configuredPaths map[string]string
	environment     map[string]string
	live            bool
}

// diagnoseRuntimes discovers the enabled Runtimes with the same discovery the
// Daemon uses.
func diagnoseRuntimes(ctx context.Context, configuredPaths, environment map[string]string, enabled []string) ([]runtimeDiagnostic, error) {
	if enabled == nil {
		enabled = runtimeTypes
	}
	checks, err := requestRuntimeChecks(ctx, enabled, runtimeRequest{configuredPaths: configuredPaths, environment: environment})
	diagnostics := make([]runtimeDiagnostic, 0, len(checks))
	for _, check := range checks {
		diagnostics = append(diagnostics, check.diagnostic)
	}
	return diagnostics, err
}

// checkRuntime diagnoses one Runtime; live also asks a ready Runtime for a
// model reply.
func checkRuntime(ctx context.Context, runtimeType string, request runtimeRequest) (runtimeCheck, error) {
	checks, err := requestRuntimeChecks(ctx, []string{runtimeType}, request)
	if err != nil {
		return runtimeCheck{}, err
	}
	return checks[0], nil
}

func requestRuntimeChecks(ctx context.Context, types []string, request runtimeRequest) ([]runtimeCheck, error) {
	var selectedRuntimes []string
	if len(types) < len(runtimeTypes) {
		selectedRuntimes = types
	}
	options, err := computerconfig.RuntimeDiscoveryOptions(computerconfig.RuntimeDiscoveryRequest{
		ConfiguredPaths: request.configuredPaths,
		Environment:     request.environment,
		Runtimes:        selectedRuntimes,
	})
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	var discovered provider.DiscoveryResult
	var live map[string]provider.LiveCheck
	if request.live {
		discovered, live = provider.DiscoverLive(ctx, options, 75*time.Second)
	} else {
		if discovered, err = provider.Discover(ctx, options); err != nil {
			return nil, err
		}
	}
	values := slices.DeleteFunc(slices.Clone(discovered.Diagnostics), func(value provider.RuntimeDiagnostic) bool {
		return !slices.Contains(runtimeTypes, value.Type)
	})
	if len(values) != len(types) {
		return nil, errors.New("Runtime diagnostics are incomplete")
	}
	checks := make([]runtimeCheck, 0, len(types))
	for _, runtimeType := range types {
		index := slices.IndexFunc(values, func(value provider.RuntimeDiagnostic) bool { return value.Type == runtimeType })
		if index == -1 || !slices.Contains([]string{"ready", "authentication_required", "not_installed", "incompatible", "error"}, values[index].Status) {
			return nil, errors.New("Runtime diagnostic is invalid")
		}
		value := values[index]
		available := value.Status == "ready" || value.Status == "authentication_required"
		if available && (value.ExecutablePath == "" || value.EntryPath == "") {
			return nil, errors.New("Runtime diagnostic has no executable path")
		}
		diagnostic := runtimeDiagnostic{Type: runtimeType, Status: value.Status, Available: available, Version: value.Version}
		if value.ExecutablePath != "" {
			diagnostic.ExecutablePath, diagnostic.EntryPath = value.ExecutablePath, value.EntryPath
		}
		if value.Error != nil {
			diagnostic.ErrorMessage = value.Error.Message
		}
		check := runtimeCheck{diagnostic: diagnostic}
		if result, ok := live[runtimeType]; ok {
			check.live = &result
		}
		checks = append(checks, check)
	}
	return checks, nil
}
