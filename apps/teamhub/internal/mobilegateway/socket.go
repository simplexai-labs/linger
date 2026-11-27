package mobilegateway

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/gorilla/websocket"
)

type socketHead struct {
	Path string `json:"path"`
}

// voiceBridgePath is the only message stream a phone may open.
const voiceBridgePath = "/v1/voice-bridge"

func (s *session) dispatchSocket(st *stream, raw []byte) {
	defer st.finish()
	var head socketHead
	if err := json.Unmarshal(raw, &head); err != nil || head.Path != voiceBridgePath {
		_ = s.emitJSON(st.ctx, frameReset, st.id, resetPayload{Code: "NOT_FOUND"})
		return
	}
	if s.gateway.voiceBridgeURL == "" {
		_ = s.emitJSON(st.ctx, frameReset, st.id, resetPayload{Code: "VOICE_UNAVAILABLE"})
		return
	}
	header := http.Header{}
	header.Set("Authorization", "Bearer "+s.gateway.voiceBridgeToken)
	header.Set("X-Linger-Phone-Id", s.currentPhone().ID)
	dialer := websocket.Dialer{HandshakeTimeout: handshakeTimeout}
	conn, response, err := dialer.DialContext(st.ctx, s.gateway.voiceBridgeURL, header)
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	if err != nil {
		s.logger.Warn("mobile.voice_bridge_unreachable", "error", err)
		_ = s.emitJSON(st.ctx, frameReset, st.id, resetPayload{Code: "VOICE_UNAVAILABLE"})
		return
	}
	defer conn.Close()
	conn.SetReadLimit(maxFramePayload)
	switched, _ := json.Marshal(responseHead{Status: http.StatusSwitchingProtocols, Headers: map[string][]string{}})
	if err := s.emitUrgent(st.ctx, frameResponse, st.id, switched); err != nil {
		return
	}

	ctx, cancel := context.WithCancel(st.ctx)
	defer cancel()
	// Bridge to phone.
	go func() {
		defer cancel()
		for {
			kind, message, err := conn.ReadMessage()
			if err != nil {
				_ = s.emitUrgent(s.ctx, frameEnd, st.id, nil)
				return
			}
			frameKind := frameData
			if kind == websocket.TextMessage {
				frameKind = frameText
			}
			if err := s.emitUrgent(ctx, frameKind, st.id, message); err != nil {
				return
			}
		}
	}()
	// Phone to bridge.
	go func() {
		<-ctx.Done()
		// The loop below may be waiting for the phone; wake it so the stream
		// is released when the bridge ends first.
		st.abort(context.Canceled)
		_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), deadline(writeTimeout))
		_ = conn.Close()
	}()
	for {
		item, err := st.next()
		if err != nil {
			cancel()
			return
		}
		kind := websocket.BinaryMessage
		if item.kind == frameText {
			kind = websocket.TextMessage
		}
		_ = conn.SetWriteDeadline(deadline(writeTimeout))
		if err := conn.WriteMessage(kind, item.data); err != nil {
			cancel()
			return
		}
	}
}
