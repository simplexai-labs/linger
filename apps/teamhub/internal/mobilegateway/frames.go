package mobilegateway

import (
	"encoding/binary"
	"errors"
	"fmt"
)

// frameType names one kind of plaintext frame inside a session. The values
// are part of the wire protocol in docs/mobile.md and never change meaning.
type frameType byte

const (
	frameRequest  frameType = 1
	frameData     frameType = 2
	frameEnd      frameType = 3
	frameResponse frameType = 4
	frameReset    frameType = 5
	frameSocket   frameType = 6
	frameText     frameType = 7
	frameControl  frameType = 8
	frameWindow   frameType = 9
)

const (
	frameHeaderSize = 5
	// maxNoiseMessage is the Noise transport message limit; the 16-byte tag
	// leaves the rest for one frame.
	maxNoiseMessage = 65535
	maxFramePayload = maxNoiseMessage - 16 - frameHeaderSize
	// dataChunk keeps body frames well below the frame limit.
	dataChunk = 60 * 1024
	// streamWindow is how many unacknowledged body bytes the phone may send
	// on one stream before it waits for a window frame.
	streamWindow = 256 * 1024
	// maxOpenStreams bounds the streams one session holds open at once.
	maxOpenStreams = 64
	// controlStream carries session-level control messages.
	controlStream uint32 = 0
)

var errMalformedFrame = errors.New("malformed frame")

type frame struct {
	kind    frameType
	stream  uint32
	payload []byte
}

func encodeFrame(kind frameType, stream uint32, payload []byte) ([]byte, error) {
	if len(payload) > maxFramePayload {
		return nil, fmt.Errorf("frame payload of %d bytes exceeds %d", len(payload), maxFramePayload)
	}
	out := make([]byte, frameHeaderSize+len(payload))
	out[0] = byte(kind)
	binary.BigEndian.PutUint32(out[1:frameHeaderSize], stream)
	copy(out[frameHeaderSize:], payload)
	return out, nil
}

func decodeFrame(raw []byte) (frame, error) {
	if len(raw) < frameHeaderSize {
		return frame{}, errMalformedFrame
	}
	kind := frameType(raw[0])
	if kind < frameRequest || kind > frameWindow {
		return frame{}, errMalformedFrame
	}
	return frame{kind: kind, stream: binary.BigEndian.Uint32(raw[1:frameHeaderSize]), payload: raw[frameHeaderSize:]}, nil
}

func windowPayload(increment uint32) []byte {
	out := make([]byte, 4)
	binary.BigEndian.PutUint32(out, increment)
	return out
}
