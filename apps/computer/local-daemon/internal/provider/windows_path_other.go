//go:build !windows

package provider

func readHostWindowsRegistryEnv() (windowsRegistrySnapshot, bool) {
	return windowsRegistrySnapshot{}, false
}
