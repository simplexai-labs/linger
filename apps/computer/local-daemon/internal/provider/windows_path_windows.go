//go:build windows

package provider

import (
	"strings"

	"golang.org/x/sys/windows/registry"
)

func readHostWindowsRegistryEnv() (windowsRegistrySnapshot, bool) {
	var snapshot windowsRegistrySnapshot
	snapshot.MachineEnv, snapshot.MachinePath = readWindowsRegistryEnvironmentKey(
		registry.LOCAL_MACHINE,
		`SYSTEM\CurrentControlSet\Control\Session Manager\Environment`,
	)
	snapshot.UserEnv, snapshot.UserPath = readWindowsRegistryEnvironmentKey(
		registry.CURRENT_USER,
		`Environment`,
	)
	snapshot.VolatileEnv, _ = readWindowsRegistryEnvironmentKey(
		registry.CURRENT_USER,
		`Volatile Environment`,
	)
	return snapshot, snapshot.MachinePath != "" || snapshot.UserPath != ""
}

func readWindowsRegistryEnvironmentKey(root registry.Key, subkey string) (map[string]string, string) {
	key, err := registry.OpenKey(root, subkey, registry.QUERY_VALUE)
	if err != nil {
		return nil, ""
	}
	defer func() {
		_ = key.Close()
	}()

	names, err := key.ReadValueNames(0)
	if err != nil && len(names) == 0 {
		return nil, ""
	}
	values := make(map[string]string, len(names))
	var pathValue string
	for _, name := range names {
		value, valueType, getErr := key.GetStringValue(name)
		if getErr != nil {
			continue
		}
		if valueType != registry.SZ && valueType != registry.EXPAND_SZ {
			continue
		}
		if strings.EqualFold(name, "PATH") {
			if pathValue == "" {
				pathValue = value
			}
			continue
		}
		values[name] = value
	}
	return values, pathValue
}
