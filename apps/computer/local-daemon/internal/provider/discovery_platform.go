package provider

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

func platformEnvironment(source map[string]string) map[string]string {
	if runtime.GOOS != "windows" {
		return source
	}
	result := make(map[string]string, len(source)+1)
	for key, value := range source {
		result[strings.ToUpper(key)] = value
	}
	if result["HOME"] == "" {
		result["HOME"] = result["USERPROFILE"]
	}
	if result["HOME"] == "" {
		result["HOME"], _ = os.UserHomeDir()
	}
	return result
}
func executableNames(name string) []string {
	if runtime.GOOS != "windows" || filepath.Ext(name) != "" {
		return []string{name}
	}
	return []string{name + ".exe", name + ".com", name + ".cmd", name + ".bat", name + ".ps1"}
}
func executableDirectories(pathValue string, environment map[string]string) []string {
	directories := filepath.SplitList(pathValue)
	if home := environment["HOME"]; home != "" {
		directories = append(directories, filepath.Join(home, ".local", "bin"))
	}
	if runtime.GOOS == "windows" {
		if appdata := environment["APPDATA"]; appdata != "" {
			directories = append(directories, filepath.Join(appdata, "npm"))
		}
	}
	return directories
}

// ExecutableCandidates lists, in search order, where Runtime discovery looks
// for name in environment: PATH, then the default install folders a CLI
// installed after the Daemon started lands in (~/.local/bin, and %APPDATA%\npm
// on Windows). Local tools that run another CLI find it the same way.
func ExecutableCandidates(name string, environment map[string]string) []string {
	environment = platformEnvironment(environment)
	return executableCandidates(name, environment["PATH"], environment)
}

func executableCandidates(name, path string, environment map[string]string) []string {
	var candidates []string
	for _, directory := range executableDirectories(path, environment) {
		if !filepath.IsAbs(directory) {
			continue
		}
		for _, filename := range executableNames(name) {
			candidates = append(candidates, filepath.Join(directory, filename))
		}
	}
	return candidates
}
