package voice

import (
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicelive"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

// The Runtime offers page tools only when the live context names web, so a
// session the Mobile App created must reach it as mobile.
func TestLiveContextNamesTheSessionClient(t *testing.T) {
	for _, tc := range []struct {
		client string
		want   teamhubinternal.VoiceLiveContextClient
	}{
		{voicemedia.ClientWeb, teamhubinternal.VoiceLiveContextClientWeb},
		{voicemedia.ClientMobile, teamhubinternal.VoiceLiveContextClientMobile},
		{"", teamhubinternal.VoiceLiveContextClientWeb},
	} {
		got := liveContextClient(voicelive.Session{Client: tc.client})
		if got == nil || *got != tc.want {
			t.Fatalf("client %q = %v, want %q", tc.client, got, tc.want)
		}
	}
}
