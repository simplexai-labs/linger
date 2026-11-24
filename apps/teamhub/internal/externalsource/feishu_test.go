package externalsource

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/feishu"
	nodeapi "github.com/simplexai-labs/linger/contracts-go/nodeservicesinternal"
)

type unusedFeishuComputer struct{}

func (unusedFeishuComputer) CallLocalComputerToolResult(context.Context, nodeapi.LocalComputerToolCall) (map[string]any, error) {
	return nil, errors.New("not called")
}

func TestFeishuMailIsAvailableWhereComputersAreReachable(t *testing.T) {
	service := New(nil, &composio.Client{})
	app, ok := service.catalogApp(FeishuMailAppKey)
	if !ok || app.Availability != AppAvailabilityUnavailable || len(app.Capabilities) != 0 || app.SupportsReauthorization {
		t.Fatalf("Feishu Mail without a Computer gateway = %+v", app)
	}
	if _, err := service.connectionAdapter(FeishuMailAppKey); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("adapter without a Computer gateway: %v", err)
	}
	if service.ConnectionProvidersConfigured() {
		t.Fatal("a provider is configured without Composio or a Computer gateway")
	}

	service.ConfigureFeishu(unusedFeishuComputer{}, nil, nil)
	app, _ = service.catalogApp(FeishuMailAppKey)
	if app.Availability != AppAvailabilityAvailable || !slices.Contains(app.Capabilities, "connect") || !app.SupportsReauthorization || app.LogoURL != "" {
		t.Fatalf("Feishu Mail with a Computer gateway = %+v", app)
	}
	if slices.Contains(app.Capabilities, "personal_wiki_import") {
		t.Fatal("Feishu Mail must not be offered as a Profile source")
	}
	adapter, err := service.connectionAdapter(FeishuMailAppKey)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := adapter.(feishuConnection); !ok {
		t.Fatalf("adapter = %T, want feishuConnection", adapter)
	}
	if !service.ConnectionProvidersConfigured() || service.ProviderConfigured() {
		t.Fatal("Feishu Mail alone must configure connections but not Composio")
	}
	// Composio apps stay unavailable: Feishu Mail does not configure them.
	if gmail, _ := service.catalogApp("gmail"); gmail.Availability != AppAvailabilityUnavailable {
		t.Fatalf("gmail with only Feishu Mail = %+v", gmail)
	}
}

func TestFeishuFailuresMapToConnectionOutcomes(t *testing.T) {
	for _, loggedOut := range []error{feishu.ErrAuthorizationRequired, &feishu.ScopesMissingError{Scopes: []string{"mail:user_mailbox:readonly"}}, &feishu.APIError{Code: 99991677}} {
		if code, _, fail := connectionIdentityFailurePolicy(FeishuMailAppKey, loggedOut); code != "provider_auth_failed" || !fail {
			t.Fatalf("%v = %s %v", loggedOut, code, fail)
		}
	}
	if code, retry, fail := connectionIdentityFailurePolicy(FeishuMailAppKey, &feishu.RateLimitError{RetryAfter: 2 * time.Minute}); code != "provider_rate_limited" || retry != 2*time.Minute || fail {
		t.Fatalf("rate limit = %s %s %v", code, retry, fail)
	}
	offline := &feishu.ComputerError{Status: feishu.StatusComputerOffline}
	if code, _, fail := connectionIdentityFailurePolicy(FeishuMailAppKey, offline); code != "provider_identity_unavailable" || fail {
		t.Fatalf("an offline Computer = %s %v", code, fail)
	}
	if class := connectionCheckErrorClass(offline); class != feishu.StatusComputerOffline {
		t.Fatalf("class = %s", class)
	}
	if !upstreamGone(errFeishuUpstreamGone) {
		t.Fatal("a forgotten Feishu upstream must count as revoked")
	}
}

func TestFeishuConnectBlockerLetsALoginFixWhatItCan(t *testing.T) {
	offline := &feishu.ComputerError{Status: feishu.StatusComputerOffline}
	cases := []struct {
		name   string
		status error
		check  func(error) bool
	}{
		{"ready", nil, func(err error) bool { return err == nil }},
		{"logged out", feishu.ErrAuthorizationRequired, func(err error) bool { return err == nil }},
		{"scopes a login grants", &feishu.ScopesMissingError{Scopes: []string{"mail:a"}}, func(err error) bool { return err == nil }},
		{"scopes the app does not enable", &feishu.ScopesMissingError{Scopes: []string{"mail:a"}, NotEnabled: []string{"mail:a"}, AppID: "cli_abc", Brand: "feishu"}, func(err error) bool {
			var notEnabled *FeishuScopesNotEnabledError
			return errors.As(err, &notEnabled) && slices.Equal(notEnabled.Scopes, []string{"mail:a"}) && notEnabled.PermissionsURL == "https://open.feishu.cn/app/cli_abc/auth"
		}},
		{"offline Computer", offline, func(err error) bool { return errors.Is(err, offline) }},
	}
	for _, tc := range cases {
		if got := feishuConnectBlocker(tc.status); !tc.check(got) {
			t.Errorf("%s: blocker = %v", tc.name, got)
		}
	}
}
