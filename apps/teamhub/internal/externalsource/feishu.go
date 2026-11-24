package externalsource

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/feishu"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	nodeapi "github.com/simplexai-labs/linger/contracts-go/nodeservicesinternal"
)

// FeishuMailAppKey is the catalog key of Feishu Mail. Composio has no Feishu
// toolkit, so TeamHub runs these connections itself, through the owner's own
// lark-cli on their Computer.
const FeishuMailAppKey = "feishu_mail"

// feishuToolkit is the toolkit slug Feishu upstreams and connections record.
const feishuToolkit = "feishu"

// feishuAuthConfigID fills the auth config of Feishu upstreams: lark-cli's
// own Feishu app authorizes them, not one TeamHub knows.
const feishuAuthConfigID = "lark-cli"

const (
	// feishuLinkLifetime bounds a connection whose owner's lark-cli already
	// serves Feishu Mail; its first check activates it.
	feishuLinkLifetime = 15 * time.Minute
	// feishuToolDeadline bounds one Feishu Mail call on the Computer.
	feishuToolDeadline = 60 * time.Second
	// feishuLoginWaitDeadline bounds one wait for a login its owner is
	// finishing; the checks of a pending connection repeat it.
	feishuLoginWaitDeadline = 20 * time.Second
)

// FeishuComputer runs a tool on an owner's Computer and returns its result
// whatever its status.
type FeishuComputer interface {
	CallLocalComputerToolResult(context.Context, nodeapi.LocalComputerToolCall) (map[string]any, error)
}

// FeishuScopesNotEnabledError reports mail scopes the Feishu app behind the
// owner's lark-cli does not enable: its console must enable them before a
// login can grant them. PermissionsURL is that app's permissions page, when
// known.
type FeishuScopesNotEnabledError struct {
	Scopes         []string
	PermissionsURL string
}

func (e *FeishuScopesNotEnabledError) Error() string {
	return "the lark-cli Feishu app does not enable: " + strings.Join(e.Scopes, " ")
}

type feishuCatalog struct {
	computer  FeishuComputer
	renderer  mailRenderer
	downloads *http.Client
}

// ConfigureFeishu enables Feishu Mail. computer reaches each owner's
// Computer, renderer turns synced mail into Wiki documents, and downloads
// fetches the attachment links Feishu hands out.
func (s *Service) ConfigureFeishu(computer FeishuComputer, renderer mailRenderer, downloads *http.Client) {
	if computer == nil {
		return
	}
	s.feishu = &feishuCatalog{computer: computer, renderer: renderer, downloads: downloads}
}

// FeishuConfigured reports whether Feishu Mail can reach owners' Computers.
func (s *Service) FeishuConfigured() bool { return s.feishu != nil }

// ConnectionProvidersConfigured reports whether any connection provider
// works: Composio, or Feishu Mail through owners' Computers.
func (s *Service) ConnectionProvidersConfigured() bool {
	return s.ProviderConfigured() || s.FeishuConfigured()
}

// feishuMailbox is upstreamID's mailbox.
func (s *Service) feishuMailbox(ctx context.Context, upstreamID string) (feishu.Mailbox, error) {
	if s.feishu == nil {
		return feishu.Mailbox{}, ErrUnavailable
	}
	queries := store.New(s.pool)
	accountID, err := queries.GetExternalUpstreamAccount(ctx, upstreamID)
	if errors.Is(err, pgx.ErrNoRows) {
		return feishu.Mailbox{}, errFeishuUpstreamGone
	}
	if err != nil {
		return feishu.Mailbox{}, err
	}
	mailbox, err := s.feishuAccountMailbox(ctx, queries, accountID)
	if err != nil {
		return feishu.Mailbox{}, err
	}
	// An identified connection stays bound to its mailbox: lark-cli acts as
	// whoever is logged in now, which the owner may have switched. A
	// reauthorization candidate is not bound, so a login to another mailbox
	// ends it as an identity mismatch.
	principal, err := queries.GetFeishuUpstreamPrincipal(ctx, upstreamID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return feishu.Mailbox{}, err
	}
	if address, ok := strings.CutPrefix(principal, FeishuMailAppKey+":"); ok && address != "" {
		mailbox = mailbox.BoundTo(address)
	}
	return mailbox, nil
}

// feishuAccountMailbox is the Feishu mailbox of accountID's own lark-cli,
// reached through the online Computer that runs the account's AnotherMe.
func (s *Service) feishuAccountMailbox(ctx context.Context, queries *store.Queries, accountID string) (feishu.Mailbox, error) {
	target, err := queries.GetFeishuMailComputerTarget(ctx, accountID)
	if errors.Is(err, pgx.ErrNoRows) {
		return feishu.Mailbox{}, &feishu.ComputerError{Status: feishu.StatusComputerOffline}
	}
	if err != nil {
		return feishu.Mailbox{}, err
	}
	call := func(ctx context.Context, tool string, arguments map[string]any) (map[string]any, error) {
		deadline := int(feishuToolDeadline / time.Millisecond)
		if tool == "login_wait" {
			deadline = int(feishuLoginWaitDeadline / time.Millisecond)
		}
		result, err := s.feishu.computer.CallLocalComputerToolResult(ctx, nodeapi.LocalComputerToolCall{
			TenantId: target.TenantID, OwnerActorId: target.OwnerActorID, ComputerId: target.ComputerID,
			AgentId: target.AgentManagementID, ToolSessionId: idgen.New("feishu_mail_call"),
			Server: nodeapi.FeishuMail, ToolName: tool, Arguments: arguments, DeadlineMs: &deadline,
		})
		if err != nil {
			return nil, &feishu.ComputerError{Status: "outcome_unknown", Detail: err.Error()}
		}
		return result, nil
	}
	return feishu.NewMailbox(call, s.feishu.downloads), nil
}

// createFeishuLinkInTx records the upstream a lark-cli login fills. An owner
// whose lark-cli already serves Feishu Mail needs no login: the link has no
// page and the connection's first check activates it. Otherwise the Computer
// starts a login named after the upstream, and its page is the link.
func (s *Service) createFeishuLinkInTx(ctx context.Context, tx pgx.Tx, accountID string) (composio.Link, error) {
	if s.feishu == nil {
		return composio.Link{}, ErrUnavailable
	}
	mailbox, err := s.feishuAccountMailbox(ctx, store.New(tx), accountID)
	if err != nil {
		return composio.Link{}, err
	}
	upstreamID := idgen.New("feishu_upstream")
	link := composio.Link{AuthConfigID: feishuAuthConfigID, ConnectedAccountID: upstreamID, ExpiresAt: time.Now().UTC().Add(feishuLinkLifetime).Truncate(time.Second)}
	_, err = mailbox.Status(ctx)
	if blocked := feishuConnectBlocker(err); blocked != nil {
		return composio.Link{}, blocked
	}
	if err != nil {
		// Not logged in, or missing scopes a login grants: the login fixes it.
		login, err := mailbox.StartLogin(ctx, upstreamID)
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

// feishuConnectBlocker reports what keeps the owner's Computer from
// connecting Feishu Mail, from the result of its status check: nothing when
// lark-cli serves the mailbox already or a lark-cli login would make it, the
// scopes its Feishu app does not enable, or the Computer's own failure, such
// as being offline or having no lark-cli.
func feishuConnectBlocker(statusErr error) error {
	var missing *feishu.ScopesMissingError
	switch {
	case statusErr == nil:
		return nil
	case errors.As(statusErr, &missing) && len(missing.NotEnabled) > 0:
		return &FeishuScopesNotEnabledError{Scopes: missing.NotEnabled, PermissionsURL: missing.PermissionsURL()}
	case feishu.IsAuthFailure(statusErr):
		return nil
	default:
		return statusErr
	}
}

// CheckFeishuConnect checks whether the account's Computer can start Feishu Mail
// authorization without starting a login or creating a connection.
func (s *Service) CheckFeishuConnect(ctx context.Context, accountID string) error {
	if s.feishu == nil {
		return ErrUnavailable
	}
	mailbox, err := s.feishuAccountMailbox(ctx, store.New(s.pool), accountID)
	if err != nil {
		return err
	}
	_, err = mailbox.Status(ctx)
	return feishuConnectBlocker(err)
}

var errFeishuUpstreamGone = errors.New("the Feishu upstream no longer exists")

// feishuConnection is the connection lifecycle of a Feishu upstream. Its
// status is the owner's lark-cli login: a login started for the upstream
// keeps it pending until the owner finishes it on Feishu's page.
type feishuConnection struct{ service *Service }

func (c feishuConnection) Status(ctx context.Context, upstreamID string) (composio.ConnectionStatus, error) {
	mailbox, err := c.service.feishuMailbox(ctx, upstreamID)
	if err != nil {
		return "", err
	}
	state, err := mailbox.WaitLogin(ctx, upstreamID)
	if err != nil {
		return "", err
	}
	if state == feishu.LoginPending {
		return composio.ConnectionPending, nil
	}
	_, err = mailbox.Status(ctx)
	switch {
	case err == nil:
		return composio.ConnectionActive, nil
	case feishu.IsAuthFailure(err):
		return composio.ConnectionExpired, nil
	default:
		return "", err
	}
}

func (c feishuConnection) Identify(ctx context.Context, upstreamID string, status composio.ConnectionStatus) (connectionIdentity, error) {
	if status != composio.ConnectionActive {
		return connectionIdentity{}, nil
	}
	mailbox, err := c.service.feishuMailbox(ctx, upstreamID)
	if err != nil {
		return connectionIdentity{}, err
	}
	address, err := mailbox.Status(ctx)
	if err != nil {
		return connectionIdentity{}, err
	}
	return connectionIdentity{Label: address, PrincipalKey: FeishuMailAppKey + ":" + address}, nil
}

// Revoke forgets nothing: TeamHub holds no Feishu credentials, and the
// owner's lark-cli login serves their own other uses too.
func (c feishuConnection) Revoke(context.Context, string) error { return nil }

// isFeishuApp reports whether TeamHub runs appKey itself.
func isFeishuApp(appKey string) bool { return appKey == FeishuMailAppKey }

// createLinkInTx records the upstream a new authorization fills and returns
// its consent page: a lark-cli login for Feishu, a Composio Connect Link
// otherwise. managedConfigID is the Composio auth config, unused for Feishu.
func (s *Service) createLinkInTx(ctx context.Context, tx pgx.Tx, accountID, appKey, managedConfigID string) (composio.Link, error) {
	if isFeishuApp(appKey) {
		return s.createFeishuLinkInTx(ctx, tx, accountID)
	}
	return s.createManagedLinkInTx(ctx, tx, accountID, toolkitForApp(appKey), managedConfigID)
}

// feishuUpstreamGone reports a Feishu upstream that is already forgotten.
func feishuUpstreamGone(err error) bool { return errors.Is(err, errFeishuUpstreamGone) }
