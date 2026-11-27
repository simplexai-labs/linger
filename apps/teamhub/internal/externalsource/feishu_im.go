package externalsource

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/feishu"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	nodeapi "github.com/simplexai-labs/linger/contracts-go/nodeservicesinternal"
)

// FeishuIMAppKey is the catalog key of Feishu IM. Composio has no Feishu
// toolkit, so TeamHub runs these connections itself, through the owner's own
// lark-cli on their Computer.
const FeishuIMAppKey = "feishu_im"

type feishuIMCatalog struct {
	computer FeishuComputer
}

// ConfigureFeishuIM enables Feishu IM. computer reaches each owner's Computer.
func (s *Service) ConfigureFeishuIM(computer FeishuComputer) {
	if computer == nil {
		return
	}
	s.feishuIM = &feishuIMCatalog{computer: computer}
}

// FeishuIMConfigured reports whether Feishu IM can reach owners' Computers.
func (s *Service) FeishuIMConfigured() bool { return s.feishuIM != nil }

// feishuIMClient is the Feishu IM of upstreamID's owner.
func (s *Service) feishuIMClient(ctx context.Context, upstreamID string) (feishu.IM, error) {
	if s.feishuIM == nil {
		return feishu.IM{}, ErrUnavailable
	}
	queries := store.New(s.pool)
	accountID, err := queries.GetExternalUpstreamAccount(ctx, upstreamID)
	if errors.Is(err, pgx.ErrNoRows) {
		return feishu.IM{}, errFeishuUpstreamGone
	}
	if err != nil {
		return feishu.IM{}, err
	}
	client, err := s.feishuIMForAccount(ctx, queries, accountID)
	if err != nil {
		return feishu.IM{}, err
	}
	// An identified connection stays bound to its account: lark-cli acts as
	// whoever is logged in now, which the owner may have switched. A
	// reauthorization candidate is not bound, so a login to another account
	// ends it as an identity mismatch.
	principal, err := queries.GetFeishuUpstreamPrincipal(ctx, upstreamID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return feishu.IM{}, err
	}
	if openID, ok := strings.CutPrefix(principal, FeishuIMAppKey+":"); ok && openID != "" {
		client = client.BoundTo(openID)
	}
	return client, nil
}

// feishuIMForAccount is the Feishu IM of accountID's own lark-cli, reached
// through the online Computer that runs the account's AnotherMe.
func (s *Service) feishuIMForAccount(ctx context.Context, queries *store.Queries, accountID string) (feishu.IM, error) {
	target, err := queries.GetFeishuMailComputerTarget(ctx, accountID)
	if errors.Is(err, pgx.ErrNoRows) {
		return feishu.IM{}, &feishu.ComputerError{Status: feishu.StatusComputerOffline}
	}
	if err != nil {
		return feishu.IM{}, err
	}
	call := func(ctx context.Context, tool string, arguments map[string]any) (map[string]any, error) {
		deadline := int(feishuToolDeadline / time.Millisecond)
		if tool == "login_wait" {
			deadline = int(feishuLoginWaitDeadline / time.Millisecond)
		}
		result, err := s.feishuIM.computer.CallLocalComputerToolResult(ctx, nodeapi.LocalComputerToolCall{
			TenantId: target.TenantID, OwnerActorId: target.OwnerActorID, ComputerId: target.ComputerID,
			AgentId: target.AgentManagementID, ToolSessionId: idgen.New("feishu_im_call"),
			Server: nodeapi.FeishuIm, ToolName: tool, Arguments: arguments, DeadlineMs: &deadline,
		})
		if err != nil {
			return nil, &feishu.ComputerError{Status: "outcome_unknown", Detail: err.Error()}
		}
		return result, nil
	}
	return feishu.NewIM(call), nil
}

// createFeishuIMLinkInTx records the upstream a lark-cli login fills. An owner
// whose lark-cli already serves Feishu IM needs no login: the link has no page
// and the connection's first check activates it. Otherwise the Computer starts
// a login named after the upstream, and its page is the link.
func (s *Service) createFeishuIMLinkInTx(ctx context.Context, tx pgx.Tx, accountID string) (composio.Link, error) {
	if s.feishuIM == nil {
		return composio.Link{}, ErrUnavailable
	}
	client, err := s.feishuIMForAccount(ctx, store.New(tx), accountID)
	if err != nil {
		return composio.Link{}, err
	}
	upstreamID := idgen.New("feishu_im_upstream")
	link := composio.Link{AuthConfigID: feishuAuthConfigID, ConnectedAccountID: upstreamID, ExpiresAt: time.Now().UTC().Add(feishuLinkLifetime).Truncate(time.Second)}
	err = client.Status(ctx)
	if blocked := feishuConnectBlocker(err); blocked != nil {
		return composio.Link{}, blocked
	}
	if err != nil {
		// Not logged in, or missing scopes a login grants: the login fixes it.
		login, err := client.StartLogin(ctx, upstreamID)
		if err != nil {
			return composio.Link{}, err
		}
		link.RedirectURL = login.URL
		if login.ExpiresAt.Before(link.ExpiresAt) {
			link.ExpiresAt = login.ExpiresAt.UTC().Truncate(time.Second)
		}
	}
	if _, err = tx.Exec(ctx, `INSERT INTO external_connection_upstreams(upstream_id,account_id,user_id,toolkit_slug,auth_config_id) VALUES($1,$2,$2,$3,$4)`, upstreamID, accountID, feishuToolkit, feishuAuthConfigID); err != nil {
		return composio.Link{}, err
	}
	return link, nil
}

// feishuIMConnection is the connection lifecycle of a Feishu IM upstream. Its
// status is the owner's lark-cli login: a login started for the upstream keeps
// it pending until the owner finishes it on Feishu's page.
type feishuIMConnection struct{ service *Service }

func (c feishuIMConnection) Status(ctx context.Context, upstreamID string) (composio.ConnectionStatusReport, error) {
	client, err := c.service.feishuIMClient(ctx, upstreamID)
	if err != nil {
		return composio.ConnectionStatusReport{}, err
	}
	state, err := client.WaitLogin(ctx, upstreamID)
	if err != nil {
		return composio.ConnectionStatusReport{}, err
	}
	if state == feishu.LoginPending {
		return composio.ConnectionStatusReport{Status: composio.ConnectionPending, Reason: composio.ConnectionStatusReasonPending}, nil
	}
	if err = client.Status(ctx); err != nil {
		if feishu.IsAuthFailure(err) {
			return composio.ConnectionStatusReport{Status: composio.ConnectionExpired, Reason: composio.ConnectionStatusReasonExpired}, nil
		}
		return composio.ConnectionStatusReport{}, err
	}
	return composio.ConnectionStatusReport{Status: composio.ConnectionActive, Reason: composio.ConnectionStatusReasonActive}, nil
}

// Identify names the Feishu account the owner's lark-cli is logged in to, so a
// connection stays bound to it.
func (c feishuIMConnection) Identify(ctx context.Context, upstreamID string, status composio.ConnectionStatus) (connectionIdentity, error) {
	if status != composio.ConnectionActive {
		return connectionIdentity{}, nil
	}
	client, err := c.service.feishuIMClient(ctx, upstreamID)
	if err != nil {
		return connectionIdentity{}, err
	}
	identity, err := client.Identity(ctx)
	if err != nil {
		return connectionIdentity{}, err
	}
	label := identity.Name
	if label == "" {
		label = identity.OpenID
	}
	return connectionIdentity{Label: label, PrincipalKey: FeishuIMAppKey + ":" + identity.OpenID}, nil
}

// Revoke forgets nothing: TeamHub holds no Feishu credentials, and the owner's
// lark-cli login serves their own other uses too.
func (c feishuIMConnection) Revoke(context.Context, string) error { return nil }

// isFeishuIMApp reports whether appKey is Feishu IM, which TeamHub runs itself.
func isFeishuIMApp(appKey string) bool { return appKey == FeishuIMAppKey }
