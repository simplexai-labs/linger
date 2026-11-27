package transport

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

const (
	testPingInterval = 20 * time.Millisecond
	testReadTimeout  = 400 * time.Millisecond
)

// livenessGatewayStream connects to a peer that reads forever and sends
// nothing; answerPings selects whether it replies to Pings with Pongs.
func livenessGatewayStream(t *testing.T, answerPings bool) (*gatewayStream, *atomic.Int32) {
	t.Helper()
	var pings atomic.Int32
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		peer, err := upgrader.Upgrade(writer, request, nil)
		if err != nil {
			return
		}
		defer peer.Close()
		peer.SetPingHandler(func(data string) error {
			pings.Add(1)
			if !answerPings {
				return nil
			}
			return peer.WriteControl(websocket.PongMessage, []byte(data), time.Now().Add(time.Second))
		})
		for {
			if _, _, err := peer.ReadMessage(); err != nil {
				return
			}
		}
	}))
	t.Cleanup(server.Close)
	stream, err := (GatewayControlPlane{
		URL: "ws" + strings.TrimPrefix(server.URL, "http"), BearerToken: "test-token",
		PingInterval: testPingInterval, ReadTimeout: testReadTimeout,
	}).Connect(context.Background(), Hello{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = stream.Close() })
	return stream.(*gatewayStream), &pings
}

func TestGatewayIdleConnectionAnsweringPingsStaysOpen(t *testing.T) {
	stream, pings := livenessGatewayStream(t, true)
	idle := 6 * testReadTimeout
	ctx, cancel := context.WithTimeout(context.Background(), idle)
	defer cancel()
	started := time.Now()
	_, err := stream.Receive(ctx)
	if err == nil {
		t.Fatal("Receive returned a command from a silent peer")
	}
	if elapsed := time.Since(started); elapsed < idle-10*time.Millisecond {
		t.Fatalf("Receive ended after %v, before the %v context deadline: %v", elapsed, idle, err)
	}
	if pings.Load() == 0 {
		t.Fatal("peer observed no liveness pings")
	}
}

func TestGatewaySilentPeerEndsReceiveAsUnavailable(t *testing.T) {
	stream, pings := livenessGatewayStream(t, false)
	result := make(chan error, 1)
	started := time.Now()
	go func() {
		_, err := stream.Receive(context.Background())
		result <- err
	}()
	var err error
	select {
	case err = <-result:
	case <-time.After(5 * time.Second):
		t.Fatal("Receive kept waiting on a peer that stopped answering pings")
	}
	if err == nil {
		t.Fatal("Receive returned no error from a dead peer")
	}
	if elapsed := time.Since(started); elapsed < testReadTimeout {
		t.Fatalf("Receive ended after %v, before the %v read timeout", elapsed, testReadTimeout)
	}
	if got := ClassifyConnectionFailure(err); got != FailureUnavailable {
		t.Fatalf("ClassifyConnectionFailure(%v)=%v, want FailureUnavailable", err, got)
	}
	if pings.Load() == 0 {
		t.Fatal("peer observed no liveness pings")
	}
	if !stream.closed.Load() {
		t.Fatal("liveness timeout left the stream open")
	}
}

// A context deadline bounds only its own Receive call.
func TestGatewayContextDeadlineDoesNotShortenLaterReceive(t *testing.T) {
	stream, _ := livenessGatewayStream(t, true)
	if err := stream.extendReadDeadline(); err != nil {
		t.Fatal(err)
	}
	stream.contextDeadline = time.Now().Add(-time.Second)
	if err := stream.extendReadDeadline(); err != nil {
		t.Fatal(err)
	}
	stream.contextDeadline = time.Time{}
	ctx, cancel := context.WithTimeout(context.Background(), 4*testReadTimeout)
	defer cancel()
	started := time.Now()
	_, _ = stream.Receive(ctx)
	if elapsed := time.Since(started); elapsed < 4*testReadTimeout-10*time.Millisecond {
		t.Fatalf("Receive ended after %v, an earlier deadline leaked into it", elapsed)
	}
}

func TestGatewayCloseStopsPings(t *testing.T) {
	stream, pings := livenessGatewayStream(t, true)
	deadline := time.Now().Add(5 * time.Second)
	for pings.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if pings.Load() == 0 {
		t.Fatal("peer observed no liveness pings")
	}
	// Concurrent Close calls race the ping goroutine without panicking.
	closed := make(chan struct{})
	for range 4 {
		go func() {
			_ = stream.Close()
			closed <- struct{}{}
		}()
	}
	for range 4 {
		<-closed
	}
	after := pings.Load()
	time.Sleep(5 * testPingInterval)
	if got := pings.Load(); got != after {
		t.Fatalf("peer observed %d pings after Close", got-after)
	}
	select {
	case <-stream.done:
	default:
		t.Fatal("Close left the ping goroutine running")
	}
}

// A large command trickling in on a slow downlink keeps the connection alive
// even though the peer's Pongs queue behind it.
func TestGatewaySlowLargeCommandIsNotALivenessTimeout(t *testing.T) {
	const chunkBytes = 4096
	const chunks = 40
	// NextWriter holds back one buffered chunk, so gaps reach twice the pause;
	// a tenth of the read timeout leaves room for a descheduled writer.
	const pause = testReadTimeout / 10
	body := `{"type":"runtime.registration.snapshot","protocol_version":"2",` +
		`"command_id":"snapshot-slow","runner_id":"computer-local","connection_epoch":3,` +
		strings.Repeat(" ", chunkBytes*chunks) + `"registrations":[]}`
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		peer, err := upgrader.Upgrade(writer, request, nil)
		if err != nil {
			return
		}
		defer peer.Close()
		// The peer never reads while it writes, so it answers no Ping.
		message, err := peer.NextWriter(websocket.TextMessage)
		if err != nil {
			return
		}
		for offset := 0; offset < len(body); offset += chunkBytes {
			end := min(offset+chunkBytes, len(body))
			if _, err := message.Write([]byte(body[offset:end])); err != nil {
				return
			}
			time.Sleep(pause)
		}
		_ = message.Close()
		_, _, _ = peer.ReadMessage()
	}))
	t.Cleanup(server.Close)
	stream, err := (GatewayControlPlane{
		URL: "ws" + strings.TrimPrefix(server.URL, "http"), BearerToken: "test-token",
		PingInterval: testPingInterval, ReadTimeout: testReadTimeout,
	}).Connect(context.Background(), Hello{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = stream.Close() })
	started := time.Now()
	command, err := stream.Receive(context.Background())
	if err != nil {
		t.Fatalf("Receive failed after %v: %v", time.Since(started), err)
	}
	if elapsed := time.Since(started); elapsed < 3*testReadTimeout {
		t.Fatalf("command arrived after %v, too fast to exercise the read timeout", elapsed)
	}
	if command.CommandID != "snapshot-slow" {
		t.Fatalf("command=%+v, want snapshot-slow", command)
	}
}

func TestGatewayProbeLivenessDropsSilentPeerFastAndKeepsLivePeer(t *testing.T) {
	// Live peer: immediate wake probe sends Ping, peer answers Pong and restores
	// the read deadline so the stream stays open and receives a later command.
	livePingSeen := make(chan struct{}, 1)
	liveUpgrader := websocket.Upgrader{}
	liveServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		peer, err := liveUpgrader.Upgrade(writer, request, nil)
		if err != nil {
			return
		}
		defer peer.Close()
		peer.SetPingHandler(func(data string) error {
			if err := peer.WriteControl(websocket.PongMessage, []byte(data), time.Now().Add(time.Second)); err != nil {
				return err
			}
			select {
			case livePingSeen <- struct{}{}:
			default:
			}
			return peer.WriteMessage(websocket.TextMessage, []byte(
				`{"type":"runtime.registration.snapshot","protocol_version":"2","command_id":"after-wake","runner_id":"computer-local","connection_epoch":1,"registrations":[]}`,
			))
		})
		for {
			if _, _, err := peer.ReadMessage(); err != nil {
				return
			}
		}
	}))
	t.Cleanup(liveServer.Close)
	liveRaw, err := (GatewayControlPlane{
		URL: "ws" + strings.TrimPrefix(liveServer.URL, "http"), BearerToken: "test-token",
		PingInterval: 10 * time.Second, ReadTimeout: 10 * time.Second,
	}).Connect(t.Context(), Hello{})
	if err != nil {
		t.Fatal(err)
	}
	live := liveRaw.(*gatewayStream)
	t.Cleanup(func() { _ = live.Close() })

	liveResult := make(chan struct {
		commandID string
		err       error
	}, 1)
	go func() {
		cmd, recvErr := live.Receive(t.Context())
		liveResult <- struct {
			commandID string
			err       error
		}{commandID: cmd.CommandID, err: recvErr}
	}()
	if err := live.ProbeLiveness(2 * time.Second); err != nil {
		t.Fatalf("ProbeLiveness on live peer: %v", err)
	}
	select {
	case <-livePingSeen:
	case <-time.After(2 * time.Second):
		t.Fatal("live peer did not receive wake ping")
	}
	select {
	case res := <-liveResult:
		if res.err != nil || res.commandID != "after-wake" {
			t.Fatalf("live peer Receive = (%q, %v), want (after-wake, nil)", res.commandID, res.err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("live peer did not deliver command after wake probe")
	}

	// Silent peer with a long read timeout: wake probe shortens the deadline so
	// Receive fails fast instead of waiting out the long read timeout.
	silentPingSeen := make(chan struct{}, 1)
	silentUpgrader := websocket.Upgrader{}
	silentServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		peer, upgradeErr := silentUpgrader.Upgrade(writer, request, nil)
		if upgradeErr != nil {
			return
		}
		defer peer.Close()
		peer.SetPingHandler(func(string) error {
			select {
			case silentPingSeen <- struct{}{}:
			default:
			}
			return nil
		})
		for {
			if _, _, readErr := peer.ReadMessage(); readErr != nil {
				return
			}
		}
	}))
	t.Cleanup(silentServer.Close)
	silentRaw, err := (GatewayControlPlane{
		URL: "ws" + strings.TrimPrefix(silentServer.URL, "http"), BearerToken: "test-token",
		PingInterval: 10 * time.Second, ReadTimeout: 10 * time.Second,
	}).Connect(t.Context(), Hello{})
	if err != nil {
		t.Fatal(err)
	}
	silent := silentRaw.(*gatewayStream)
	t.Cleanup(func() { _ = silent.Close() })

	silentDone := make(chan error, 1)
	go func() {
		_, recvErr := silent.Receive(context.Background())
		silentDone <- recvErr
	}()
	started := time.Now()
	if err := silent.ProbeLiveness(80 * time.Millisecond); err != nil {
		t.Fatalf("ProbeLiveness on silent peer: %v", err)
	}
	select {
	case <-silentPingSeen:
	case <-time.After(2 * time.Second):
		t.Fatal("silent peer did not receive wake ping")
	}
	select {
	case recvErr := <-silentDone:
		if recvErr == nil {
			t.Fatal("expected error from silent peer after ProbeLiveness")
		}
		if elapsed := time.Since(started); elapsed > 2*time.Second {
			t.Fatalf("silent peer took %v to time out after 80ms ProbeLiveness", elapsed)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("silent peer did not time out after ProbeLiveness")
	}
}
