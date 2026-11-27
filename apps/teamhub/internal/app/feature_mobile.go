package app

import (
	"context"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/mobilegateway"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/mobilerelay"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/pairedphone"
)

// registerMobile builds the Paired Phones store and, when the deployment has
// a secret seed, the Mobile Gateway. The Gateway dispatches into a.handler,
// which New builds after the features, so it resolves it per request. Its
// Relay nodes come from the stored list once the workers start.
func (a *App) registerMobile(cfg config.MobileConfig) {
	a.pairedPhones = pairedphone.New(a.pool)
	a.mobileRelays = mobilerelay.New(a.pool)
	a.mobileRelayEnvironment = cfg.RelayURL
	a.mobileRelayLinksOff = cfg.RelayLinksOff
	a.mobilePushServiceURL = cfg.PushServiceURL
	if len(cfg.StaticKeySecret) == 0 {
		return
	}
	key, err := mobilegateway.NewStaticKey(cfg.StaticKeySecret)
	if err != nil {
		a.logger.Error("mobile.gateway_unavailable", "error", err)
		return
	}
	a.mobileGateway = mobilegateway.New(mobilegateway.Config{
		Key:              key,
		ComputerName:     computerName(),
		LANAddress:       cfg.LANAddress,
		VoiceBridgeURL:   voiceBridgeURL(a.cfg.NodeServicesURL),
		VoiceBridgeToken: a.cfg.NodeServicesInternalToken,
	}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a.handler.ServeHTTP(w, r)
	}), a.pairedPhones, a.logger)
}

// startMobileRelays adds the official and environment nodes to the stored
// list, then links the Gateway to every enabled node.
func (a *App) startMobileRelays(ctx context.Context) {
	if a.mobileRelayLinksOff {
		return
	}
	if err := a.mobileRelays.Prepare(ctx, a.mobileRelayEnvironment); err != nil {
		a.logger.Error("mobile.relays_unavailable", "error", err)
	}
	a.syncMobileRelays(ctx)
}

// syncMobileRelays hands the Gateway the enabled nodes after the list
// changed.
func (a *App) syncMobileRelays(ctx context.Context) {
	if a.mobileGateway == nil || a.mobileRelayLinksOff {
		return
	}
	a.mobileRelaySync.Lock()
	defer a.mobileRelaySync.Unlock()
	// The change is already stored; a caller that stops waiting must not
	// leave the Gateway on the old list.
	nodes, err := a.mobileRelays.List(context.WithoutCancel(ctx))
	if err != nil {
		a.logger.Error("mobile.relays_unavailable", "error", err)
		return
	}
	relays := make([]mobilegateway.Relay, 0, len(nodes))
	for _, node := range nodes {
		if node.Enabled {
			relays = append(relays, mobilegateway.Relay{ID: node.ID, URL: node.URL, Label: node.Label})
		}
	}
	a.mobileGateway.SetRelays(relays)
}

// computerName is the name a phone shows for this computer.
func computerName() string {
	name, err := os.Hostname()
	if err != nil || strings.TrimSpace(name) == "" {
		return "Linger"
	}
	return strings.TrimSuffix(name, ".local")
}

// voiceBridgeURL is the Voice Bridge websocket on Node Services.
func voiceBridgeURL(nodeServicesURL string) string {
	parsed, err := url.Parse(nodeServicesURL)
	if err != nil || parsed.Host == "" {
		return ""
	}
	switch parsed.Scheme {
	case "https":
		parsed.Scheme = "wss"
	default:
		parsed.Scheme = "ws"
	}
	parsed.Path = "/v1/voice-bridge"
	return parsed.String()
}
