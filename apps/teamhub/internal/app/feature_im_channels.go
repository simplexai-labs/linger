package app

import (
	"context"
	"strings"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/imchannel"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/realtime"
)

const imChannelWakeTimeout = 5 * time.Second

// registerIMChannels wires the IM channel service using the shared secretbox
// and Node Services internal client. Without either, channels remain read-only
// and report available=false.
func (a *App) registerIMChannels(cfg config.Config) error {
	box, err := secretBox(cfg.ExternalApps.SecretEncryptionKey)
	if err != nil {
		return err
	}
	var nodeClient imchannel.NodeClient
	if cfg.NodeServicesURL != "" && cfg.NodeServicesInternalToken != "" {
		nodeClient, err = imchannel.NewHTTPNodeClient(cfg.NodeServicesURL, cfg.NodeServicesInternalToken)
		if err != nil {
			return err
		}
	}
	a.imChannels = imchannel.New(a.queries, a.collaboration, a.typedCards, box, nodeClient, a.logger)
	return nil
}

// runIMChannelWakeLoop listens to committed Room events on the in-process
// realtime broker and wakes Node Services for Rooms with an enabled IM binding.
func (a *App) runIMChannelWakeLoop(ctx context.Context) {
	if a.imChannels == nil || !a.imChannels.Available() || a.broker == nil {
		return
	}
	sub := a.broker.Subscribe(realtime.HumanEventsTopic)
	defer sub.Close()
	for {
		select {
		case <-ctx.Done():
			return
		case <-sub.Done():
			return
		case event := <-sub.Events():
			if !strings.HasPrefix(event.Topic, "room:") {
				continue
			}
			if event.Kind != "message.created" && event.Kind != "card.changed" && event.Kind != realtime.ReconcileKind {
				continue
			}
			roomID := strings.TrimPrefix(event.Topic, "room:")
			if roomID == "" {
				continue
			}
			wakeCtx, cancel := context.WithTimeout(ctx, imChannelWakeTimeout)
			a.imChannels.WakeRoom(wakeCtx, roomID)
			cancel()
		}
	}
}
