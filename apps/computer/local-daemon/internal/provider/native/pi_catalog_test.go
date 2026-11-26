package native

import (
	"errors"
	"os/exec"
	"strings"
	"testing"
)

func TestProbePiProtocolAndModelsPreservesExitErrorAndStderr(t *testing.T) {
	t.Run("exit_code_and_stderr", func(t *testing.T) {
		inv := fixtureInvocation(t, "print", map[string]string{
			"FIXTURE_STDERR": "error: unexpected argument; api_key=sk-secret-value\n",
			"FIXTURE_EXIT":   "7",
		})
		result, err := ProbePiProtocolAndModels(t.Context(), inv)
		if result.ProtocolVerified {
			t.Fatalf("ProtocolVerified = true, want false (result=%+v, err=%v)", result, err)
		}
		if !errors.Is(err, errPiProtocolIncompatible) {
			t.Fatalf("err = %v, want errors.Is(errPiProtocolIncompatible)", err)
		}
		var exitErr *exec.ExitError
		if !errors.As(err, &exitErr) || exitErr.ExitCode() != 7 {
			t.Fatalf("err = %v, want *exec.ExitError with exit code 7", err)
		}
		if want := "error: unexpected argument; api_key=sk-secret-value"; result.Stderr != want {
			t.Fatalf("Stderr = %q, want %q", result.Stderr, want)
		}
	})

	t.Run("stderr_bounded_to_tail", func(t *testing.T) {
		const marker = "TAIL_DIAGNOSTIC_MARKER"
		noisy := strings.Repeat("a", catalogStderrLimit+2048) + marker + "\n"
		inv := fixtureInvocation(t, "print", map[string]string{
			"FIXTURE_STDERR": noisy,
			"FIXTURE_EXIT":   "5",
		})
		result, err := ProbePiProtocolAndModels(t.Context(), inv)
		if err == nil || result.ProtocolVerified {
			t.Fatalf("result = %+v, err = %v; want failure", result, err)
		}
		if len(result.Stderr) > catalogStderrLimit {
			t.Fatalf("len(Stderr) = %d, exceeds limit %d", len(result.Stderr), catalogStderrLimit)
		}
		if !strings.HasSuffix(result.Stderr, marker) {
			t.Fatalf("Stderr did not retain tail marker %q: len=%d", marker, len(result.Stderr))
		}
	})
}
