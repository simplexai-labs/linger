package agentruntimestate

import (
	"encoding/json"
	"testing"
)

func TestSpeechBecameAvailable(t *testing.T) {
	availableTrue := json.RawMessage(`{"available":true,"models":[]}`)
	availableFalse := json.RawMessage(`{"available":false,"models":[]}`)
	corrupt := json.RawMessage(`not-json`)

	cases := []struct {
		name     string
		previous json.RawMessage
		next     json.RawMessage
		want     bool
	}{
		{name: "absent to available", previous: nil, next: availableTrue, want: true},
		{name: "false to available", previous: availableFalse, next: availableTrue, want: true},
		{name: "available to available progress snapshot", previous: availableTrue, next: availableTrue, want: false},
		{name: "available to false", previous: availableTrue, next: availableFalse, want: false},
		{name: "false to false", previous: availableFalse, next: availableFalse, want: false},
		{name: "absent to false", previous: nil, next: availableFalse, want: false},
		{name: "corrupt previous to available", previous: corrupt, next: availableTrue, want: true},
	}
	for _, tc := range cases {
		if got := speechBecameAvailable(tc.previous, tc.next); got != tc.want {
			t.Errorf("%s: got %v, want %v", tc.name, got, tc.want)
		}
	}
}
