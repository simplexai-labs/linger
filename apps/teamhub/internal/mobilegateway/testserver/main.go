// Command testserver runs a Mobile Gateway on loopback with a fixed key and a
// fake TeamHub, so the Mobile App's session tests can talk to the real Go
// responder. It prints one JSON line with its address, then serves until its
// standard input closes.
package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/mobilegateway"
)

type phones struct {
	mu    sync.Mutex
	known map[string]mobilegateway.Phone
	spent bool
	// approve plays the Human: it approves a pending phone shortly after it
	// pairs.
	approve func(phoneID string)
}

func (p *phones) Resume(_ context.Context, key []byte) (mobilegateway.Phone, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	phone, ok := p.known[string(key)]
	if !ok {
		return mobilegateway.Phone{}, mobilegateway.ErrUnknownPhone
	}
	return phone, nil
}

func (p *phones) Pair(_ context.Context, request mobilegateway.PairRequest) (mobilegateway.Phone, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.spent || request.Invite != "test-invite" {
		return mobilegateway.Phone{}, mobilegateway.ErrInviteInvalid
	}
	p.spent = true
	p.known[string(request.PublicKey)] = mobilegateway.Phone{ID: "phone_test", SessionDigest: []byte("digest")}
	go func() {
		time.Sleep(200 * time.Millisecond)
		p.approve("phone_test")
	}()
	return mobilegateway.Phone{ID: "phone_test", Pending: true, ConfirmationCode: "123456"}, nil
}

func handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v0/me", func(w http.ResponseWriter, r *http.Request) {
		_, ok := mobilegateway.PhoneSession(r.Context())
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"phone_session": ok})
	})
	mux.HandleFunc("POST /v0/rooms/{room}/messages", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write(body)
	})
	mux.HandleFunc("POST /v0/rooms/{room}/message-attachment-uploads", func(w http.ResponseWriter, r *http.Request) {
		n, _ := io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"bytes":%d}`, n)
	})
	mux.HandleFunc("GET /v0/events", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		for i := range 3 {
			_, _ = fmt.Fprintf(w, "event: tick\ndata: %d\n\n", i)
			w.(http.Flusher).Flush()
			select {
			case <-r.Context().Done():
				return
			case <-time.After(20 * time.Millisecond):
			}
		}
		<-r.Context().Done()
	})
	mux.HandleFunc("GET /v0/documents/{id}/downloads", func(w http.ResponseWriter, r *http.Request) {
		size, _ := strconv.Atoi(r.URL.Query().Get("size"))
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = w.Write(bytes.Repeat([]byte("x"), size))
	})
	return mux
}

func main() {
	secret := bytes.Repeat([]byte{0x11}, 32)
	key, err := mobilegateway.NewStaticKey(secret)
	if err != nil {
		panic(err)
	}
	store := &phones{known: map[string]mobilegateway.Phone{}}
	// A Relay URL as the first argument also links the gateway to that Relay,
	// so a test can reach it through a real Relay.
	var relays []mobilegateway.Relay
	if len(os.Args) > 1 {
		relays = []mobilegateway.Relay{{ID: "relay_test", URL: os.Args[1], Label: "Test Relay"}}
	}
	gateway := mobilegateway.New(mobilegateway.Config{Key: key, ComputerName: "Test Computer", Relays: relays}, handler(),
		store, slog.New(slog.NewTextHandler(io.Discard, nil)))
	store.approve = func(phoneID string) { gateway.Approve(phoneID, []byte("digest")) }
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		panic(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		_, _ = io.Copy(io.Discard, os.Stdin)
		cancel()
	}()
	address := listener.Addr().String()
	line, _ := json.Marshal(map[string]string{
		"url":      "ws://" + address + "/v1/connect/" + gateway.HostID(),
		"host_key": hex.EncodeToString(gateway.PublicKey()),
	})
	fmt.Println(string(line))
	if len(relays) > 0 {
		go gateway.Run(ctx)
	}
	gateway.ServeLAN(ctx, listener)
}
