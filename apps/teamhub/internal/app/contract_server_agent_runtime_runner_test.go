package app

import (
	"context"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/externalsource"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/permissionreview"
	nodeapi "github.com/simplexai-labs/linger/contracts-go/nodeservicesinternal"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

type fakeFeishuComputer struct{}

func (fakeFeishuComputer) CallLocalComputerToolResult(context.Context, nodeapi.LocalComputerToolCall) (map[string]any, error) {
	return nil, nil
}

func TestConnectAgentRuntimeLocalComputerResultCarriesDeploymentFlags(t *testing.T) {
	computer := teamhubinternal.AgentRuntimeLocalComputer{ComputerId: "computer-1"}
	placements := []teamhubinternal.AgentRuntimeRunnerPlacement{}

	withBoth := externalsource.New(nil, nil)
	withBoth.ConfigureFeishu(fakeFeishuComputer{}, nil, nil)

	for _, tc := range []struct {
		name                 string
		app                  *App
		wantConnectedApps    bool
		wantPermissionReview bool
	}{
		{
			name:                 "neither configured",
			app:                  &App{},
			wantConnectedApps:    false,
			wantPermissionReview: false,
		},
		{
			name:                 "connected apps only",
			app:                  &App{externalSources: withBoth},
			wantConnectedApps:    true,
			wantPermissionReview: false,
		},
		{
			name:                 "permission review only",
			app:                  &App{permissionReviews: &permissionreview.Service{Judge: allowingJudge{}}},
			wantConnectedApps:    false,
			wantPermissionReview: true,
		},
		{
			name: "both configured",
			app: &App{
				externalSources:   withBoth,
				permissionReviews: &permissionreview.Service{Judge: allowingJudge{}},
			},
			wantConnectedApps:    true,
			wantPermissionReview: true,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := tc.app.connectAgentRuntimeLocalComputerResult(computer, placements)
			if got.ConnectedApps == nil || *got.ConnectedApps != tc.wantConnectedApps {
				t.Fatalf("ConnectedApps = %v, want %v", got.ConnectedApps, tc.wantConnectedApps)
			}
			if got.PermissionReview == nil || *got.PermissionReview != tc.wantPermissionReview {
				t.Fatalf("PermissionReview = %v, want %v", got.PermissionReview, tc.wantPermissionReview)
			}
		})
	}
}
