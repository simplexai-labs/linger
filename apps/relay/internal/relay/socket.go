package relay

import (
	"encoding/json"
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// errTooLarge marks a message over the socket's limit.
var errTooLarge = errors.New("relay: message too large")

type message struct {
	kind int
	data []byte
}

// socket owns one accepted WebSocket. Exactly one goroutine reads it and hands
// each message over an unbuffered channel, so a slow consumer stalls the
// reader instead of growing a queue.
type socket struct {
	server   *Server
	conn     *websocket.Conn
	limit    int
	messages chan message

	writeMu   sync.Mutex
	closeOnce sync.Once
	closing   chan struct{}
	// closeCode is the code this socket was closed with; zero means it ended
	// without a close handshake.
	closeCode atomic.Int32
}

func (s *Server) newSocket(conn *websocket.Conn, limit int) *socket {
	k := &socket{
		server:   s,
		conn:     conn,
		limit:    limit,
		messages: make(chan message),
		closing:  make(chan struct{}),
	}
	s.track(k)
	k.alive()
	conn.SetPongHandler(func(string) error {
		k.alive()
		return nil
	})
	conn.SetPingHandler(func(data string) error {
		k.alive()
		err := conn.WriteControl(websocket.PongMessage, []byte(data), time.Now().Add(writeTimeout))
		if errors.Is(err, websocket.ErrCloseSent) {
			return nil
		}
		return err
	})
	conn.SetCloseHandler(func(code int, _ string) error {
		k.close(code)
		return nil
	})
	go k.readLoop()
	go k.pingLoop()
	return k
}

func (k *socket) alive() {
	_ = k.conn.SetReadDeadline(time.Now().Add(k.server.silenceTimeout))
}

// readMessage reads one message through a bounded reader. gorilla's own
// SetReadLimit answers an oversized message with close code 1009 before the
// caller can act, so the Relay enforces the limit here to send 4413.
func (k *socket) readMessage() (int, []byte, error) {
	kind, reader, err := k.conn.NextReader()
	if err != nil {
		return 0, nil, err
	}
	data, err := io.ReadAll(io.LimitReader(reader, int64(k.limit)+1))
	if err != nil {
		return 0, nil, err
	}
	if len(data) > k.limit {
		return 0, nil, errTooLarge
	}
	k.alive()
	return kind, data, nil
}

// readLoop keeps reading after the socket starts closing so the peer's close
// reply is consumed instead of being answered with a TCP reset.
func (k *socket) readLoop() {
	defer k.finish()
	for {
		kind, data, err := k.readMessage()
		if errors.Is(err, errTooLarge) {
			k.close(CloseTooLarge)
			continue
		}
		if err != nil {
			return
		}
		select {
		case k.messages <- message{kind: kind, data: data}:
		case <-k.closing:
		}
	}
}

func (k *socket) pingLoop() {
	ticker := time.NewTicker(k.server.pingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-k.closing:
			return
		case <-ticker.C:
			if err := k.conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(writeTimeout)); err != nil {
				k.close(websocket.CloseGoingAway)
				return
			}
		}
	}
}

func (k *socket) writeBinary(data []byte) error {
	k.writeMu.Lock()
	defer k.writeMu.Unlock()
	_ = k.conn.SetWriteDeadline(time.Now().Add(writeTimeout))
	return k.conn.WriteMessage(websocket.BinaryMessage, data)
}

func (k *socket) writeJSON(value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	k.writeMu.Lock()
	defer k.writeMu.Unlock()
	_ = k.conn.SetWriteDeadline(time.Now().Add(writeTimeout))
	return k.conn.WriteMessage(websocket.TextMessage, data)
}

// close starts the close handshake with code. The TCP connection closes when
// the peer replies or after closeGrace, whichever comes first.
func (k *socket) close(code int) {
	k.closeOnce.Do(func() {
		k.closeCode.Store(int32(code))
		close(k.closing)
		_ = k.conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(code, ""), time.Now().Add(writeTimeout))
		time.AfterFunc(k.server.closeGrace, func() { _ = k.conn.Close() })
	})
}

// finish runs once the reader has stopped: the connection is unusable.
func (k *socket) finish() {
	k.closeOnce.Do(func() { close(k.closing) })
	_ = k.conn.Close()
	close(k.messages)
	k.server.untrack(k)
}

// endCode is the code to pass on to the other side of a splice once this
// socket's messages channel has closed.
func (k *socket) endCode() int {
	return forwardCode(int(k.closeCode.Load()))
}

// forwardCode maps a received or sent close code to one that may be sent on
// the wire; an end without a close frame becomes going away.
func forwardCode(code int) int {
	switch {
	case code == websocket.CloseNoStatusReceived:
		return websocket.CloseNormalClosure
	case code == 0, code == websocket.CloseAbnormalClosure, code == 1004, code == websocket.CloseTLSHandshake:
		return websocket.CloseGoingAway
	case code < 1000 || code > 4999:
		return websocket.CloseGoingAway
	default:
		return code
	}
}
