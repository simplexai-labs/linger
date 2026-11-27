// Package config reads the Relay's environment once at startup.
package config

import (
	"encoding/base64"
	"fmt"
	"net/netip"
	"os"
	"strings"
)

// Config holds the Relay's typed settings.
type Config struct {
	// HTTPAddress is the TCP address the HTTP server listens on.
	HTTPAddress string
	// TrustedProxies lists the networks whose X-Forwarded-For header is
	// believed when the Relay picks the client address for rate limits.
	TrustedProxies []netip.Prefix
	// PushSealKey turns the Push Service on; only the official deployment,
	// which holds the provider credentials, sets it.
	PushSealKey []byte
	// PushExpoAccessToken authenticates sends to Expo with enhanced push
	// security on.
	PushExpoAccessToken string
	// PushExpoURL is Expo's push endpoint.
	PushExpoURL string
}

const (
	defaultHTTPAddress = "0.0.0.0:8090"
	defaultPushExpoURL = "https://exp.host/--/api/v2/push/send"
)

// Load reads the RELAY_* environment.
func Load() (Config, error) {
	cfg := Config{HTTPAddress: strings.TrimSpace(os.Getenv("RELAY_HTTP_ADDRESS"))}
	if cfg.HTTPAddress == "" {
		cfg.HTTPAddress = defaultHTTPAddress
	}
	proxies, err := ParseTrustedProxies(os.Getenv("RELAY_TRUSTED_PROXIES"))
	if err != nil {
		return Config{}, err
	}
	cfg.TrustedProxies = proxies
	if raw := strings.TrimSpace(os.Getenv("RELAY_PUSH_SEAL_KEY")); raw != "" {
		key, err := base64.StdEncoding.DecodeString(raw)
		if err != nil || len(key) != 32 {
			return Config{}, fmt.Errorf("RELAY_PUSH_SEAL_KEY must be 32 bytes in base64")
		}
		cfg.PushSealKey = key
		cfg.PushExpoAccessToken = strings.TrimSpace(os.Getenv("RELAY_PUSH_EXPO_ACCESS_TOKEN"))
		if cfg.PushExpoAccessToken == "" {
			return Config{}, fmt.Errorf("RELAY_PUSH_EXPO_ACCESS_TOKEN is required when RELAY_PUSH_SEAL_KEY is set")
		}
	}
	cfg.PushExpoURL = strings.TrimSpace(os.Getenv("RELAY_PUSH_EXPO_URL"))
	if cfg.PushExpoURL == "" {
		cfg.PushExpoURL = defaultPushExpoURL
	}
	return cfg, nil
}

// ParseTrustedProxies parses a comma-separated list of CIDR prefixes or bare
// IP addresses; a bare address trusts only that host.
func ParseTrustedProxies(raw string) ([]netip.Prefix, error) {
	prefixes := []netip.Prefix{}
	for _, item := range strings.Split(raw, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if strings.Contains(item, "/") {
			prefix, err := netip.ParsePrefix(item)
			if err != nil {
				return nil, fmt.Errorf("RELAY_TRUSTED_PROXIES: %w", err)
			}
			prefixes = append(prefixes, prefix.Masked())
			continue
		}
		addr, err := netip.ParseAddr(item)
		if err != nil {
			return nil, fmt.Errorf("RELAY_TRUSTED_PROXIES: %w", err)
		}
		addr = addr.Unmap()
		prefixes = append(prefixes, netip.PrefixFrom(addr, addr.BitLen()))
	}
	return prefixes, nil
}
