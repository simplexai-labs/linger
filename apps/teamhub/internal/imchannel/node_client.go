package imchannel

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
	"github.com/simplexai-labs/linger/contracts-go/nodeservicesinternal"
)

const (
	nodePairingTimeout   = 45 * time.Second
	nodeReconcileTimeout = 15 * time.Second
)

// HTTPNodeClient calls the Node Services channels role through the generated
// node-services-internal OpenAPI client.
type HTTPNodeClient struct {
	pairingClient   *nodeservicesinternal.ClientWithResponses
	reconcileClient *nodeservicesinternal.ClientWithResponses
}

// NewHTTPNodeClient configures a NodeClient targeting baseURL with the shared internal bearer token.
func NewHTTPNodeClient(baseURL, token string) (*HTTPNodeClient, error) {
	pairingClient, err := roomagent.NewAgentManagementClient(baseURL, token, &http.Client{Timeout: nodePairingTimeout})
	if err != nil {
		return nil, fmt.Errorf("configure Node Services IM pairing client: %w", err)
	}
	reconcileClient, err := roomagent.NewAgentManagementClient(baseURL, token, &http.Client{Timeout: nodeReconcileTimeout})
	if err != nil {
		return nil, fmt.Errorf("configure Node Services IM reconcile client: %w", err)
	}
	return &HTTPNodeClient{
		pairingClient:   pairingClient,
		reconcileClient: reconcileClient,
	}, nil
}

// Reconcile asks Node Services to align its running channel adapters with TeamHub's enabled bindings.
func (c *HTTPNodeClient) Reconcile(ctx context.Context) (int, error) {
	resp, err := c.reconcileClient.ReconcileIMChannelsWithResponse(ctx)
	if err != nil {
		return 0, err
	}
	if resp.StatusCode() != http.StatusOK || resp.JSON200 == nil {
		return 0, fmt.Errorf("reconcile IM channels returned HTTP %d", resp.StatusCode())
	}
	return resp.JSON200.ActiveBindings, nil
}

// WakeRoom notifies Node Services to drain outbound events for roomID.
func (c *HTTPNodeClient) WakeRoom(ctx context.Context, roomID string) error {
	resp, err := c.reconcileClient.WakeIMChannelsWithResponse(ctx, nodeservicesinternal.InternalIMChannelWakeRequest{
		RoomId: roomID,
	})
	if err != nil {
		return err
	}
	if resp.StatusCode() != http.StatusNoContent {
		return fmt.Errorf("wake IM channels returned HTTP %d", resp.StatusCode())
	}
	return nil
}

// StartPairing starts an interactive pairing flow for provider on Node Services.
func (c *HTTPNodeClient) StartPairing(ctx context.Context, provider string, localTokens []string) (NodePairingResult, error) {
	body := nodeservicesinternal.InternalIMChannelPairingStartRequest{
		Provider: nodeservicesinternal.IMChannelProvider(provider),
	}
	if len(localTokens) > 0 {
		body.LocalTokens = &localTokens
	}
	resp, err := c.pairingClient.StartNodeIMChannelPairingWithResponse(ctx, body)
	if err != nil {
		return NodePairingResult{}, err
	}
	if resp.StatusCode() != http.StatusCreated || resp.JSON201 == nil {
		return NodePairingResult{}, fmt.Errorf("start IM pairing returned HTTP %d", resp.StatusCode())
	}
	return pairingResultFromContract(resp.JSON201), nil
}

// PollPairing polls an active pairing session on Node Services.
func (c *HTTPNodeClient) PollPairing(ctx context.Context, pairingID string) (NodePairingResult, error) {
	resp, err := c.pairingClient.PollNodeIMChannelPairingWithResponse(ctx, pairingID)
	if err != nil {
		return NodePairingResult{}, err
	}
	if resp.StatusCode() != http.StatusOK || resp.JSON200 == nil {
		return NodePairingResult{}, fmt.Errorf("poll IM pairing returned HTTP %d", resp.StatusCode())
	}
	return pairingResultFromContract(resp.JSON200), nil
}

// SubmitPairingVerifyCode forwards a verification code to Node Services.
func (c *HTTPNodeClient) SubmitPairingVerifyCode(ctx context.Context, pairingID, verifyCode string) (NodePairingResult, error) {
	resp, err := c.pairingClient.SubmitNodeIMChannelPairingVerifyCodeWithResponse(ctx, pairingID, nodeservicesinternal.IMChannelPairingVerifyRequest{
		VerifyCode: verifyCode,
	})
	if err != nil {
		return NodePairingResult{}, err
	}
	if resp.StatusCode() != http.StatusOK || resp.JSON200 == nil {
		return NodePairingResult{}, fmt.Errorf("submit IM verify code returned HTTP %d", resp.StatusCode())
	}
	return pairingResultFromContract(resp.JSON200), nil
}

func pairingResultFromContract(r *nodeservicesinternal.InternalIMChannelPairingPollResult) NodePairingResult {
	out := NodePairingResult{
		PairingID: r.PairingId,
		Provider:  string(r.Provider),
		Status:    string(r.Status),
	}
	if r.QrCodeUrl != nil {
		out.QRCodeURL = *r.QrCodeUrl
	}
	if r.ErrorCode != nil {
		out.ErrorCode = *r.ErrorCode
	}
	if r.Credentials != nil {
		out.Credentials = *r.Credentials
	}
	if r.Config != nil {
		out.Config = *r.Config
	}
	return out
}
