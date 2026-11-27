// Command relay runs the Linger Relay: it splices phone WebSockets to data
// WebSockets the computer dials out, forwarding opaque frames both ways.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/simplexai-labs/linger/apps/relay/internal/config"
	"github.com/simplexai-labs/linger/apps/relay/internal/push"
	"github.com/simplexai-labs/linger/apps/relay/internal/relay"
)

const shutdownTimeout = 10 * time.Second

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(logger); err != nil {
		logger.Error("relay.exited", "error", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	server := relay.New(relay.Options{Logger: logger, TrustedProxies: cfg.TrustedProxies})
	handler := server.Handler()
	if cfg.PushSealKey != nil {
		pushService, err := push.New(push.Options{
			SealKey: cfg.PushSealKey, ExpoAccessToken: cfg.PushExpoAccessToken, ExpoURL: cfg.PushExpoURL,
			Logger: logger, ClientAddress: server.ClientAddress,
		})
		if err != nil {
			return err
		}
		mux := http.NewServeMux()
		pushService.Register(mux)
		mux.Handle("/", handler)
		handler = mux
		logger.Info("relay.push_enabled")
	}
	httpServer := &http.Server{
		Addr:              cfg.HTTPAddress,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}
	serveErr := make(chan error, 1)
	go func() { serveErr <- httpServer.ListenAndServe() }()
	logger.Info("relay.listening", "address", cfg.HTTPAddress, "trusted_proxies", len(cfg.TrustedProxies))

	select {
	case err := <-serveErr:
		return err
	case <-ctx.Done():
	}
	logger.Info("relay.shutting_down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil && !errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	// Upgraded sockets are outside http.Server's tracking; close them with
	// going away so phones and hosts reconnect promptly.
	_ = server.Shutdown(shutdownCtx)
	return nil
}
