package provider

import (
	"maps"
	"strings"
	"testing"
	"time"
)

func TestExpandWindowsEnvVars(t *testing.T) {
	lookup := lookupWindowsEnvMap(map[string]string{
		"SYSTEMROOT":  `C:\Windows`,
		"NESTED_ONE":  `%Nested_Two%\bin`,
		"NESTED_TWO":  `%SystemRoot%\tools`,
		"SELF":        `%SELF%\loop`,
		"CYCLE_A":     `%CYCLE_B%`,
		"CYCLE_B":     `%CYCLE_A%`,
		"LOCALAPPDAT": `C:\Users\lx\AppData\Local`,
	})
	for _, tc := range []struct {
		name string
		raw  string
		want string
	}{
		{
			name: "case insensitive and nested",
			raw:  `%nested_one%;%systemroot%\System32`,
			want: `C:\Windows\tools\bin;C:\Windows\System32`,
		},
		{
			name: "preserves empty unknown and unmatched percents",
			raw:  `%%;%UNKNOWN%;%DANGLING;prefix`,
			want: `%%;%UNKNOWN%;%DANGLING;prefix`,
		},
		{
			name: "bounds self referential expansion",
			raw:  `%SELF%`,
			want: `%SELF%\loop\loop\loop\loop`,
		},
		{
			name: "bounds mutual cycle expansion",
			raw:  `%CYCLE_A%`,
			want: `%CYCLE_A%`,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := expandWindowsEnvVars(tc.raw, lookup); got != tc.want {
				t.Fatalf("expandWindowsEnvVars(%q) = %q, want %q", tc.raw, got, tc.want)
			}
		})
	}
}

func TestResolveWindowsRegistryPathExpansionAndPrecedence(t *testing.T) {
	snapshot := windowsRegistrySnapshot{
		MachineEnv: map[string]string{
			"NVM_SYMLINK": `%ProgramFiles%\nodejs`,
			"SHARED_TOOL": `C:\machine-shared`,
		},
		VolatileEnv: map[string]string{
			"VOL_BIN": `%LOCALAPPDATA%\VolatileBin`,
		},
		UserEnv: map[string]string{
			"SHARED_TOOL": `%LOCALAPPDATA%\user-shared`,
			"PY_HOME":     `%USERPROFILE%\AppData\Local\Programs\Python\Python313`,
			"PY_TOOLS":    `%PY_HOME%\Scripts`,
		},
		// Simulates a broken installer writing REG_SZ containing %SystemRoot% / %VAR%.
		MachinePath: `%SystemRoot%\system32;%NVM_SYMLINK%;%SHARED_TOOL%;C:\Program Files\Git\cmd`,
		UserPath:    `%PY_HOME%;%PY_TOOLS%;%SHARED_TOOL%;%VOL_BIN%;%LOCALAPPDATA%\Microsoft\WindowsApps`,
	}
	source := map[string]string{
		"SystemRoot":   `C:\Windows`,
		"ProgramFiles": `C:\Program Files`,
		"USERPROFILE":  `C:\Users\lx`,
		"LOCALAPPDATA": `C:\Users\lx\AppData\Local`,
	}

	got := resolveWindowsRegistryPath(snapshot, source)
	want := strings.Join([]string{
		`C:\Windows\system32`,
		`C:\Program Files\nodejs`,
		`C:\machine-shared`,
		`C:\Program Files\Git\cmd`,
		`C:\Users\lx\AppData\Local\Programs\Python\Python313`,
		`C:\Users\lx\AppData\Local\Programs\Python\Python313\Scripts`,
		`C:\Users\lx\AppData\Local\user-shared`,
		`C:\Users\lx\AppData\Local\VolatileBin`,
		`C:\Users\lx\AppData\Local\Microsoft\WindowsApps`,
	}, ";")
	if got != want {
		t.Fatalf("resolveWindowsRegistryPath =\n %q\nwant:\n %q", got, want)
	}
}

func TestMergeWindowsSearchPathOrderAndDeduplication(t *testing.T) {
	machine := ` C:\Windows\System32\ ; "C:\Program Files\nodejs" ; C:\ ; ; `
	user := `c:/windows/system32;C:\Users\lx\Python313\;C:\Users\lx\AppData\Local\Microsoft\WindowsApps;\\server\share\tools\`
	inherited := `C:\Users\lx\AppData\Local\Microsoft\WindowsApps\;C:\Custom\Bin;"C:\Users\lx\Python313";\\SERVER\Share\tools;C:/`

	got := mergeWindowsSearchPath(machine, user, inherited)
	want := strings.Join([]string{
		`C:\Windows\System32\`,
		`C:\Program Files\nodejs`,
		`C:\`,
		`C:\Users\lx\Python313\`,
		`C:\Users\lx\AppData\Local\Microsoft\WindowsApps`,
		`\\server\share\tools\`,
		`C:\Custom\Bin`,
	}, ";")
	if got != want {
		t.Fatalf("mergeWindowsSearchPath = %q, want %q", got, want)
	}
}

func TestTerminalEnvironmentCacheResolveWindowsRefreshesAndRetainsLastGood(t *testing.T) {
	previousReader := readWindowsRegistryEnv
	t.Cleanup(func() {
		readWindowsRegistryEnv = previousReader
	})

	now := time.Date(2026, 11, 26, 12, 0, 0, 0, time.UTC)
	var currentSnapshot windowsRegistrySnapshot
	var snapshotOK bool
	readWindowsRegistryEnv = func() (windowsRegistrySnapshot, bool) {
		return currentSnapshot, snapshotOK
	}

	cache := NewTerminalEnvironmentCache()
	cache.now = func() time.Time { return now }

	source := map[string]string{
		"SYSTEMROOT":   `C:\Windows`,
		"LOCALAPPDATA": `C:\Users\lx\AppData\Local`,
		"PATH":         `C:\Users\lx\AppData\Local\Microsoft\WindowsApps;C:\LingerManaged`,
	}

	currentSnapshot = windowsRegistrySnapshot{
		MachinePath: `%SystemRoot%\system32`,
		UserPath:    `C:\Users\lx\Python313;%LOCALAPPDATA%\Microsoft\WindowsApps`,
	}
	snapshotOK = true
	first := cache.resolveWindows(maps.Clone(source))
	wantFirst := `C:\Windows\system32;C:\Users\lx\Python313;C:\Users\lx\AppData\Local\Microsoft\WindowsApps;C:\LingerManaged`
	if first["PATH"] != wantFirst {
		t.Fatalf("first resolveWindows PATH = %q, want %q", first["PATH"], wantFirst)
	}

	// Simulate an installer adding Node.js while the Daemon stays alive.
	now = now.Add(time.Minute)
	currentSnapshot.MachinePath = `%SystemRoot%\system32;C:\Program Files\nodejs`
	second := cache.resolveWindows(maps.Clone(source))
	wantSecond := `C:\Windows\system32;C:\Program Files\nodejs;C:\Users\lx\Python313;C:\Users\lx\AppData\Local\Microsoft\WindowsApps;C:\LingerManaged`
	if second["PATH"] != wantSecond {
		t.Fatalf("refreshed resolveWindows PATH = %q, want %q", second["PATH"], wantSecond)
	}

	// Simulate a transient registry read failure: retain last good captured PATH.
	now = now.Add(time.Minute)
	snapshotOK = false
	third := cache.resolveWindows(maps.Clone(source))
	if third["PATH"] != wantSecond {
		t.Fatalf("fallback resolveWindows PATH = %q, want %q", third["PATH"], wantSecond)
	}
}
