package computerconfig

import "testing"

func TestPreferredRuntimeConfigKeepsAnEnabledRuntime(t *testing.T) {
	for _, field := range []string{`,"preferred_runtime":"pi"`, `,"enabled_runtimes":["pi","claude"],"preferred_runtime":"pi"`} {
		t.Run(field, func(t *testing.T) {
			config, err := loadConfigFields(t, field)
			if err != nil || config.PreferredRuntime != "pi" {
				t.Fatalf("preferred=%q err=%v, want pi", config.PreferredRuntime, err)
			}
		})
	}
}

func TestPreferredRuntimeConfigOmissionPrefersNone(t *testing.T) {
	config, err := loadConfigFields(t, "")
	if err != nil || config.PreferredRuntime != "" {
		t.Fatalf("preferred=%q err=%v, want none", config.PreferredRuntime, err)
	}
}

func TestPreferredRuntimeConfigRejectsUnsupportedOrDisabledRuntime(t *testing.T) {
	for _, field := range []string{`,"preferred_runtime":"other"`, `,"enabled_runtimes":["codex"],"preferred_runtime":"pi"`} {
		t.Run(field, func(t *testing.T) {
			if _, err := loadConfigFields(t, field); err == nil {
				t.Fatal("invalid preferred Runtime accepted")
			}
		})
	}
}
