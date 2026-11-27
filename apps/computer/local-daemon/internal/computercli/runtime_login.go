package computercli

import (
	"context"
	"errors"
	"os/exec"
	"slices"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/computerconfig"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/process"
)

// executeRuntimeLogin opens a Runtime on this terminal so the user can sign in
// to it. Discovery, environment and launcher handling are the daemon's own, so
// the user signs in to the process the daemon will later start: on Windows that
// means the Runtime's native entry point and the Node runtime this Computer
// ships, not whatever Node the machine happens to have.
func (c *cli) executeRuntimeLogin(ctx context.Context, parsed command) (int, error) {
	name := runtimeNames[parsed.runtime]
	request, err := c.runtimeRequest(parsed)
	if err != nil {
		return 0, err
	}
	check, err := c.deps.checkRuntime(ctx, parsed.runtime, request)
	if err != nil {
		return 0, err
	}
	switch check.diagnostic.Status {
	case "ready", "authentication_required":
	case "not_installed":
		c.out(name + " is not installed.\n" + installStep(parsed.runtime, c.deps.goos) + "\n")
		return exitCodes[categoryRuntimeUnavailable], nil
	case "incompatible":
		c.out("Upgrade " + name + " before signing in.\n")
		return exitCodes[categoryCapabilityProbe], nil
	default:
		detail := check.diagnostic.ErrorMessage
		if detail == "" {
			detail = "The check failed"
		}
		c.out(name + ": " + detail + "\nFix the error above, then run " + c.command + " runtime check " + parsed.runtime + ".\n")
		return exitCodes[categoryInternal], nil
	}

	version := ""
	if check.diagnostic.Version != "" {
		version = " (" + check.diagnostic.Version + ")"
	}
	c.out("Opening " + name + version + ". Sign in, then exit to return here.\n")
	cmd := exec.Command(check.diagnostic.ExecutablePath)
	cmd.Env = environmentList(computerconfig.RuntimeEnvironment(request.environment, ""))
	cmd.Stdin, cmd.Stdout, cmd.Stderr = c.deps.stdin, c.deps.stdout, c.deps.stderr
	process.PrepareForeground(cmd)
	code, err := c.deps.runInteractive(cmd)
	if err != nil {
		return 0, wrapError(categoryInternal, "Unable to run "+name+": "+err.Error(), err)
	}

	// The Runtime shares this terminal, so the Ctrl+C that leaves it also
	// cancelled ctx; the re-check drops that cancellation and listens for a new
	// interrupt registered only now, so the user can still abandon a slow check.
	recheck, stop := c.deps.interruptible(context.WithoutCancel(ctx))
	defer stop()
	after, err := c.deps.checkRuntime(recheck, parsed.runtime, request)
	if err == nil && recheck.Err() == nil {
		row := newRuntimeCheckRow(after, c.deps.goos, c.command)
		c.out(formatRuntimeProgress(row))
		if row.Status == "READY" {
			c.out("\n" + name + " is ready.\n")
		}
	}
	return code, nil
}

// runtimeRequest reads the configured Runtime paths and the environment a
// Runtime started from this computer gets. Login is optional: a saved config
// only supplies configured paths.
func (c *cli) runtimeRequest(parsed command) (runtimeRequest, error) {
	configured, err := fileExists(parsed.configPath)
	if err != nil {
		return runtimeRequest{}, err
	}
	configuredPaths := parsed.runtimePaths
	environment := c.deps.environment
	var tempBase string
	if configured {
		config := inspectComputerConfig(parsed.configPath, c.deps.environment, c.command)
		if configuredPaths == nil {
			configuredPaths = config.runtimePaths
		}
		if config.codexHome != "" {
			environment = withVariable(environment, "CODEX_HOME", config.codexHome)
		}
		tempBase = validatedProbeTempBase(config.stateDirectory)
	}
	return runtimeRequest{configuredPaths: configuredPaths, environment: environment, tempBase: tempBase}, nil
}

// environmentList renders a Runtime environment for exec.Cmd, sorted so a
// failing launch shows the same variables in the same order every time.
func environmentList(environment map[string]string) []string {
	entries := make([]string, 0, len(environment))
	for key, value := range environment {
		entries = append(entries, key+"="+value)
	}
	slices.Sort(entries)
	return entries
}

// runRuntimeInteractive runs a Runtime on the CLI's own terminal and returns
// its exit code. A Runtime that exits nonzero did not crash the CLI, so the
// code is reported as is and stdout stays on the user's terminal.
func runRuntimeInteractive(cmd *exec.Cmd) (int, error) {
	if err := cmd.Run(); err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return exit.ExitCode(), nil
		}
		return 0, err
	}
	return 0, nil
}
