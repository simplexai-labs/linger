package externalsource

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"unicode"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/custommcp"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/secretbox"
)

// CustomMCPAppKey identifies connections whose tools are served by a custom MCP endpoint.
const CustomMCPAppKey = "custom_mcp"

type customMCPCatalog struct {
	client CustomMCPClient
	box    *secretbox.Box
}

// CustomMCPClient discovers and invokes tools on behalf of an external connection.
type CustomMCPClient interface {
	Discover(context.Context, string, string) ([]custommcp.Tool, error)
	Call(context.Context, string, string, string, map[string]any) (json.RawMessage, error)
}

// CustomMCPConnection is the owner-visible configuration. It never contains credentials.
type CustomMCPConnection struct {
	ID       string           `json:"id"`
	Name     string           `json:"name"`
	Endpoint string           `json:"endpoint"`
	HasToken bool             `json:"has_token"`
	Revision int64            `json:"revision"`
	Tools    []custommcp.Tool `json:"tools"`
}

// ConfigureCustomMCP installs the public-endpoint client and optional encryption key.
func (s *Service) ConfigureCustomMCP(box *secretbox.Box, client CustomMCPClient) {
	if client == nil {
		client = custommcp.NewClient()
	}
	s.customMCP = &customMCPCatalog{client: client, box: box}
}

// TestCustomMCP discovers tools without saving credentials or calling a tool.
func (s *Service) TestCustomMCP(ctx context.Context, endpoint, token string) ([]custommcp.Tool, error) {
	if s.customMCP == nil {
		return nil, ErrUnavailable
	}
	return s.customMCP.client.Discover(ctx, strings.TrimSpace(endpoint), token)
}

// ListCustomMCP returns only configurations in the current owner's tenant.
func (s *Service) ListCustomMCP(ctx context.Context, tenantID, ownerActorID string) ([]CustomMCPConnection, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT c.id,c.identity_label,m.endpoint,m.encrypted_token IS NOT NULL,c.revision,m.tools
		FROM custom_mcp_connections m JOIN external_connections c ON c.id=m.connection_id
		WHERE m.tenant_id=$1 AND m.owner_actor_id=$2 AND c.status='active'
		ORDER BY c.created_at,c.id`, tenantID, ownerActorID)
	if err != nil {
		return nil, err
	}
	result, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (CustomMCPConnection, error) {
		var item CustomMCPConnection
		err := row.Scan(&item.ID, &item.Name, &item.Endpoint, &item.HasToken, &item.Revision, &item.Tools)
		return item, err
	})
	if result == nil && err == nil {
		result = []CustomMCPConnection{}
	}
	return result, err
}

// SaveCustomMCP verifies the endpoint before atomically writing its configuration and tool catalog.
func (s *Service) SaveCustomMCP(ctx context.Context, accountID, tenantID, ownerActorID string, item CustomMCPConnection, suppliedToken *string) (CustomMCPConnection, error) {
	if s.customMCP == nil {
		return CustomMCPConnection{}, ErrUnavailable
	}
	item.Name = strings.TrimSpace(item.Name)
	item.Endpoint = strings.TrimSpace(item.Endpoint)
	var token string
	var sealed []byte
	if suppliedToken != nil {
		token = *suppliedToken
	} else if item.ID != "" {
		err := s.pool.QueryRow(ctx, `SELECT m.encrypted_token FROM custom_mcp_connections m JOIN external_connections c ON c.id=m.connection_id
			WHERE c.id=$1 AND c.revision=$2 AND c.status='active' AND m.tenant_id=$3 AND m.owner_actor_id=$4 AND m.endpoint=$5`,
			item.ID, item.Revision, tenantID, ownerActorID, item.Endpoint).Scan(&sealed)
		if errors.Is(err, pgx.ErrNoRows) {
			return CustomMCPConnection{}, ErrStaleRevision
		}
		if err != nil {
			return CustomMCPConnection{}, err
		}
		if len(sealed) != 0 {
			if s.customMCP.box == nil {
				return CustomMCPConnection{}, ErrManagedKeyStorageMissing
			}
			plaintext, err := s.customMCP.box.Open(sealed)
			if err != nil {
				return CustomMCPConnection{}, err
			}
			token = string(plaintext)
		}
	}
	if item.Name == "" || len(item.Name) > 160 || strings.ContainsFunc(item.Name, unicode.IsControl) ||
		(token != "" && (strings.Contains(item.Name, token) || strings.Contains(item.Endpoint, token))) {
		return CustomMCPConnection{}, ErrInvalid
	}
	if token != "" && len(sealed) == 0 {
		if s.customMCP.box == nil {
			return CustomMCPConnection{}, ErrManagedKeyStorageMissing
		}
		var err error
		sealed, err = s.customMCP.box.Seal([]byte(token))
		if err != nil {
			return CustomMCPConnection{}, err
		}
	}
	tools, err := s.TestCustomMCP(ctx, item.Endpoint, token)
	if err != nil {
		return CustomMCPConnection{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return CustomMCPConnection{}, err
	}
	defer tx.Rollback(ctx)
	if item.ID == "" {
		item.ID = idgen.New("external_connection")
		_, err = tx.Exec(ctx, `
			INSERT INTO external_connections
				(id,account_id,provider,upstream_connection_id,status,toolkit_slug,identity_label,active_since,status_checked_at)
			VALUES ($1,$2,$3,$1,'active',$3,$4,now(),now())`, item.ID, accountID, CustomMCPAppKey, item.Name)
		if err == nil {
			_, err = tx.Exec(ctx, `INSERT INTO custom_mcp_connections
				(connection_id,tenant_id,owner_actor_id,endpoint,encrypted_token,tools)
				VALUES ($1,$2,$3,$4,$5,$6)`, item.ID, tenantID, ownerActorID, item.Endpoint, sealed, tools)
		}
		item.Revision = 1
	} else {
		err = tx.QueryRow(ctx, `
			UPDATE external_connections c SET identity_label=$5,revision=c.revision+1,updated_at=now(),status_checked_at=now()
			FROM custom_mcp_connections m WHERE m.connection_id=c.id AND c.id=$1 AND c.account_id=$2
				AND m.tenant_id=$3 AND m.owner_actor_id=$4 AND c.revision=$6 AND c.status='active'
			RETURNING c.revision`, item.ID, accountID, tenantID, ownerActorID, item.Name, item.Revision).Scan(&item.Revision)
		if errors.Is(err, pgx.ErrNoRows) {
			return CustomMCPConnection{}, ErrStaleRevision
		}
		if err == nil {
			_, err = tx.Exec(ctx, `UPDATE custom_mcp_connections SET endpoint=$2,encrypted_token=$3,tools=$4 WHERE connection_id=$1`,
				item.ID, item.Endpoint, sealed, tools)
		}
	}
	if err != nil {
		return CustomMCPConnection{}, mapDatabaseError(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return CustomMCPConnection{}, err
	}
	item.Tools = tools
	item.HasToken = len(sealed) != 0
	return item, nil
}

// DeleteCustomMCP revokes the connection and removes its encrypted credentials.
func (s *Service) DeleteCustomMCP(ctx context.Context, tenantID, ownerActorID, connectionID string) error {
	tag, err := s.pool.Exec(ctx, `WITH revoked AS (
		UPDATE external_connections c SET status='revoked',revision=c.revision+1,updated_at=now()
		FROM custom_mcp_connections m WHERE c.id=m.connection_id AND c.id=$1 AND m.tenant_id=$2 AND m.owner_actor_id=$3
		RETURNING c.id
	) DELETE FROM custom_mcp_connections m USING revoked WHERE m.connection_id=revoked.id`, connectionID, tenantID, ownerActorID)
	if err == nil && tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return err
}

// CustomMCPTools loads the catalog at the exact authorized revision.
func (s *Service) CustomMCPTools(ctx context.Context, connection AgentToolConnection) ([]custommcp.Tool, error) {
	var tools []custommcp.Tool
	err := s.pool.QueryRow(ctx, `SELECT m.tools FROM custom_mcp_connections m JOIN external_connections c ON c.id=m.connection_id
		WHERE c.id=$1 AND c.revision=$2 AND c.status='active'`, connection.ID, connection.Revision).Scan(&tools)
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrNotActive
	}
	return tools, err
}

// InvokeCustomMCP dispatches a permitted call at the pinned configuration revision.
func (s *Service) InvokeCustomMCP(ctx context.Context, connection AgentToolConnection, name string, arguments map[string]any) (json.RawMessage, error) {
	if s.customMCP == nil {
		return nil, errors.Join(custommcp.ErrNotDispatched, ErrUnavailable)
	}
	var endpoint string
	var sealed []byte
	err := s.pool.QueryRow(ctx, `SELECT m.endpoint,m.encrypted_token FROM custom_mcp_connections m JOIN external_connections c ON c.id=m.connection_id
		JOIN external_connection_agent_grants g ON g.connection_id=c.id AND g.tenant_id=m.tenant_id AND g.represented_human_actor_id=m.owner_actor_id
		WHERE c.id=$1 AND c.revision=$2 AND c.status='active' AND g.agent_actor_id=$3 AND g.revision=$4 AND g.status='active'`,
		connection.ID, connection.Revision, connection.AgentActorID, connection.GrantRevision).Scan(&endpoint, &sealed)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotActive
	}
	if err != nil {
		return nil, errors.Join(custommcp.ErrNotDispatched, err)
	}
	var token []byte
	if len(sealed) != 0 {
		if s.customMCP.box == nil {
			return nil, errors.Join(custommcp.ErrNotDispatched, ErrUnavailable)
		}
		token, err = s.customMCP.box.Open(sealed)
		if err != nil {
			return nil, errors.Join(custommcp.ErrNotDispatched, err)
		}
	}
	return s.customMCP.client.Call(ctx, endpoint, string(token), name, arguments)
}
