package mobilerelay

import (
	"context"
	"errors"
	"testing"
)

func TestNormalizeURLKeepsOnlyAWebSocketOrigin(t *testing.T) {
	for raw, want := range map[string]string{
		"ws://120.26.232.218:7787":   "ws://120.26.232.218:7787",
		" wss://Relay.Example.com/ ": "wss://relay.example.com",
	} {
		got, err := NormalizeURL(raw)
		if err != nil || got != want {
			t.Fatalf("NormalizeURL(%q) = %q, %v; want %q", raw, got, err, want)
		}
	}
	for _, raw := range []string{
		"https://relay.example.com", "ws://", "ws://user:pass@relay.example.com",
		"wss://relay.example.com/v1/host", "wss://relay.example.com?x=1", "relay.example.com",
	} {
		if _, err := NormalizeURL(raw); err == nil {
			t.Fatalf("NormalizeURL(%q) accepted a URL that is not a bare origin", raw)
		}
	}
}

func TestLabelForFallsBackToTheHost(t *testing.T) {
	if got := labelFor("  ", "ws://203.0.113.7:7787"); got != "203.0.113.7:7787" {
		t.Fatalf("labelFor = %q", got)
	}
	if got := labelFor("Office", "ws://203.0.113.7:7787"); got != "Office" {
		t.Fatalf("labelFor = %q", got)
	}
}

func TestCheckPublicRefusesPrivateAddresses(t *testing.T) {
	for raw, want := range map[string]error{
		"ws://127.0.0.1:7787":      ErrPrivate,
		"ws://10.0.0.8:7787":       ErrPrivate,
		"ws://192.168.1.20":        ErrPrivate,
		"ws://169.254.169.254":     ErrPrivate,
		"ws://[::1]:7787":          ErrPrivate,
		"ws://120.26.232.218:7787": nil,
	} {
		if err := CheckPublic(context.Background(), raw); !errors.Is(err, want) {
			t.Errorf("CheckPublic(%q) = %v, want %v", raw, err, want)
		}
	}
}
