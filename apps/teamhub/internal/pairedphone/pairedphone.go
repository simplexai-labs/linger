// Package pairedphone owns Pairing Invites and Paired Phones: who may open a
// Mobile App session with this computer, the device Session each phone acts
// through, and the push token it registered.
package pairedphone

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/mobilegateway"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

const (
	// InviteLifetime bounds how long a pairing code works.
	InviteLifetime = 10 * time.Minute
	// PendingLifetime bounds how long a paired phone waits for approval.
	PendingLifetime = 10 * time.Minute
	// sessionLifetime is how long one device Session lives; the Gateway
	// replaces it once less than sessionRefresh remains.
	sessionLifetime = 90 * 24 * time.Hour
	sessionRefresh  = 14 * 24 * time.Hour
	maxNameLength   = 80
)

// ErrNotFound reports a phone that is not paired with the caller's Account.
var ErrNotFound = errors.New("paired phone not found")

// Service stores Pairing Invites and Paired Phones.
type Service struct {
	pool    *pgxpool.Pool
	queries *store.Queries
}

// New builds the Service.
func New(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool, queries: store.New(pool)}
}

// Invite is a fresh pairing invite. Token is shown once, inside the pairing
// code; only its digest is stored.
type Invite struct {
	Token     string
	ExpiresAt time.Time
}

// CreateInvite starts a pairing for the signed-in Account.
func (s *Service) CreateInvite(ctx context.Context, accountID string) (Invite, error) {
	token := make([]byte, 32)
	_, _ = rand.Read(token)
	digest := sha256.Sum256(token)
	row, err := s.queries.CreateMobilePairingInvite(ctx, store.CreateMobilePairingInviteParams{
		ID: idgen.New("pairing_invite"), AccountID: accountID, TokenHash: digest[:],
		Lifetime: interval(InviteLifetime),
	})
	if err != nil {
		return Invite{}, fmt.Errorf("create pairing invite: %w", err)
	}
	return Invite{Token: base64.RawURLEncoding.EncodeToString(token), ExpiresAt: row.ExpiresAt.Time}, nil
}

// Pair spends an invite and records a pending phone with a confirmation
// code, in one transaction. The phone acts only after the Human approves it.
func (s *Service) Pair(ctx context.Context, request mobilegateway.PairRequest) (mobilegateway.Phone, error) {
	token, err := base64.RawURLEncoding.DecodeString(request.Invite)
	if err != nil || len(token) != 32 {
		return mobilegateway.Phone{}, mobilegateway.ErrInviteInvalid
	}
	name := strings.TrimSpace(request.Name)
	if name == "" || utf8.RuneCountInString(name) > maxNameLength {
		name = "Phone"
	}
	if request.Platform != "ios" && request.Platform != "android" {
		return mobilegateway.Phone{}, mobilegateway.ErrBadPairRequest
	}
	if len(request.PublicKey) != 32 {
		return mobilegateway.Phone{}, mobilegateway.ErrBadPairRequest
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return mobilegateway.Phone{}, fmt.Errorf("begin pairing: %w", err)
	}
	defer tx.Rollback(ctx)
	q := store.New(tx)
	digest := sha256.Sum256(token)
	invite, err := q.ConsumeMobilePairingInvite(ctx, digest[:])
	if errors.Is(err, pgx.ErrNoRows) {
		return mobilegateway.Phone{}, mobilegateway.ErrInviteInvalid
	}
	if err != nil {
		return mobilegateway.Phone{}, fmt.Errorf("spend pairing invite: %w", err)
	}
	code := confirmationCode()
	phoneID, err := q.CreatePendingPairedPhone(ctx, store.CreatePendingPairedPhoneParams{
		ID: idgen.New("phone"), AccountID: invite.AccountID, PublicKey: request.PublicKey,
		Name: name, Platform: request.Platform, ConfirmationCode: code,
	})
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) && postgresError.Code == "23505" &&
		postgresError.ConstraintName == "paired_phones_public_key_key" {
		// The key already belongs to a phone: a phone pairs with a fresh
		// key, so pairing again with a known one is a bad request.
		return mobilegateway.Phone{}, mobilegateway.ErrBadPairRequest
	}
	if err != nil {
		return mobilegateway.Phone{}, fmt.Errorf("record pending phone: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return mobilegateway.Phone{}, fmt.Errorf("commit pairing: %w", err)
	}
	return mobilegateway.Phone{ID: phoneID, Pending: true, ConfirmationCode: code}, nil
}

// confirmationCode is six random decimal digits.
func confirmationCode() string {
	var raw [4]byte
	_, _ = rand.Read(raw[:])
	return fmt.Sprintf("%06d", binary.BigEndian.Uint32(raw[:])%1_000_000)
}

// Resume authenticates a paired phone by its static key. An approved phone
// gets a live device Session, replacing one that expired, is about to, or was
// revoked by a password change. A pending phone gets its confirmation code
// again until the pending lifetime ends. A removed phone stays removed.
func (s *Service) Resume(ctx context.Context, publicKey []byte) (mobilegateway.Phone, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return mobilegateway.Phone{}, fmt.Errorf("begin resume: %w", err)
	}
	defer tx.Rollback(ctx)
	q := store.New(tx)
	row, err := q.GetPairedPhoneByKey(ctx, publicKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return mobilegateway.Phone{}, mobilegateway.ErrUnknownPhone
	}
	if err != nil {
		return mobilegateway.Phone{}, fmt.Errorf("read paired phone: %w", err)
	}
	if row.RemovedAt.Valid {
		return mobilegateway.Phone{}, mobilegateway.ErrPhoneRevoked
	}
	if !row.ApprovedAt.Valid {
		if time.Since(row.CreatedAt.Time) > PendingLifetime {
			if err := q.DeletePendingPairedPhone(ctx, row.ID); err != nil {
				return mobilegateway.Phone{}, fmt.Errorf("drop expired pairing: %w", err)
			}
			if err := tx.Commit(ctx); err != nil {
				return mobilegateway.Phone{}, fmt.Errorf("commit expired pairing: %w", err)
			}
			return mobilegateway.Phone{}, mobilegateway.ErrPairingExpired
		}
		return mobilegateway.Phone{ID: row.ID, Pending: true, ConfirmationCode: row.ConfirmationCode}, nil
	}
	digest := row.SessionTokenHash
	if row.SessionRevokedAt.Valid || time.Until(row.SessionExpiresAt.Time) < sessionRefresh {
		if err := q.RevokePhoneSession(ctx, store.RevokePhoneSessionParams{ID: row.SessionID.String, Reason: "phone_rotated"}); err != nil {
			return mobilegateway.Phone{}, fmt.Errorf("retire device session: %w", err)
		}
		var sessionID string
		sessionID, digest, err = createSession(ctx, q, row.AccountID)
		if err != nil {
			return mobilegateway.Phone{}, err
		}
		if err := q.ReplacePairedPhoneSession(ctx, store.ReplacePairedPhoneSessionParams{
			ID: row.ID, SessionID: pgtype.Text{String: sessionID, Valid: true},
		}); err != nil {
			return mobilegateway.Phone{}, fmt.Errorf("replace device session: %w", err)
		}
	} else if err := q.TouchPairedPhone(ctx, row.ID); err != nil {
		return mobilegateway.Phone{}, fmt.Errorf("touch paired phone: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return mobilegateway.Phone{}, fmt.Errorf("commit resume: %w", err)
	}
	return mobilegateway.Phone{ID: row.ID, SessionDigest: digest}, nil
}

// Approve confirms a pending phone the Human recognized by its code and
// creates its device Session. It reports ErrNotFound for a phone that is not
// pending any more.
func (s *Service) Approve(ctx context.Context, accountID, phoneID string) ([]byte, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("begin approval: %w", err)
	}
	defer tx.Rollback(ctx)
	q := store.New(tx)
	sessionID, digest, err := createSession(ctx, q, accountID)
	if err != nil {
		return nil, err
	}
	_, err = q.ApprovePairedPhone(ctx, store.ApprovePairedPhoneParams{
		ID: phoneID, AccountID: accountID, SessionID: pgtype.Text{String: sessionID, Valid: true},
		PendingLifetime: interval(PendingLifetime),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("approve paired phone: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit approval: %w", err)
	}
	return digest, nil
}

// createSession inserts a device Session. Its token hash is random, not the
// hash of any token, so the Session is reachable only through the Gateway.
func createSession(ctx context.Context, q *store.Queries, accountID string) (string, []byte, error) {
	digest := make([]byte, 32)
	_, _ = rand.Read(digest)
	id, err := q.CreatePhoneSession(ctx, store.CreatePhoneSessionParams{
		ID: idgen.New("session"), AccountID: accountID, TokenHash: digest, Lifetime: interval(sessionLifetime),
	})
	if err != nil {
		return "", nil, fmt.Errorf("create device session: %w", err)
	}
	return id, digest, nil
}

// Phone is one row of the Paired Phones list.
type Phone struct {
	ID       string
	Name     string
	Platform string
	PairedAt time.Time
	// Pending phones wait for the Human to compare ConfirmationCode and
	// approve them.
	Pending          bool
	ConfirmationCode string
	LastSeenAt       time.Time
	PushEnabled      bool
}

// List returns the Account's paired and pending phones, newest first.
func (s *Service) List(ctx context.Context, accountID string) ([]Phone, error) {
	rows, err := s.queries.ListPairedPhones(ctx, store.ListPairedPhonesParams{AccountID: accountID, PendingLifetime: interval(PendingLifetime)})
	if err != nil {
		return nil, fmt.Errorf("list paired phones: %w", err)
	}
	phones := make([]Phone, 0, len(rows))
	for _, row := range rows {
		phone := Phone{
			ID: row.ID, Name: row.Name, Platform: row.Platform, PairedAt: row.CreatedAt.Time,
			Pending: !row.ApprovedAt.Valid, LastSeenAt: row.LastSeenAt.Time, PushEnabled: row.PushEnabled,
		}
		if phone.Pending {
			phone.ConfirmationCode = row.ConfirmationCode
		}
		phones = append(phones, phone)
	}
	return phones, nil
}

// Remove unpairs a phone and revokes its device Session in one transaction.
// Removing a phone that is already removed succeeds; an unknown one reports
// ErrNotFound.
func (s *Service) Remove(ctx context.Context, accountID, phoneID string) error {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin remove: %w", err)
	}
	defer tx.Rollback(ctx)
	q := store.New(tx)
	sessionID, err := q.RemovePairedPhone(ctx, store.RemovePairedPhoneParams{ID: phoneID, AccountID: accountID})
	if errors.Is(err, pgx.ErrNoRows) {
		exists, existsErr := q.PairedPhoneExists(ctx, store.PairedPhoneExistsParams{ID: phoneID, AccountID: accountID})
		if existsErr != nil {
			return fmt.Errorf("read paired phone: %w", existsErr)
		}
		if !exists {
			return ErrNotFound
		}
		return nil
	}
	if err != nil {
		return fmt.Errorf("remove paired phone: %w", err)
	}
	if sessionID.Valid {
		if err := q.RevokePhoneSession(ctx, store.RevokePhoneSessionParams{ID: sessionID.String, Reason: "phone_removed"}); err != nil {
			return fmt.Errorf("revoke device session: %w", err)
		}
	}
	return tx.Commit(ctx)
}

// PhoneForSession returns the paired phone acting through a Session, or
// ErrNotFound for a browser Session.
func (s *Service) PhoneForSession(ctx context.Context, sessionID string) (string, error) {
	row, err := s.queries.GetPairedPhoneBySession(ctx, pgtype.Text{String: sessionID, Valid: true})
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", fmt.Errorf("read paired phone: %w", err)
	}
	return row.ID, nil
}

// SetPushGrant saves or clears (empty grant) the push grant a phone obtained
// from the Push Service at serviceURL for this computer.
func (s *Service) SetPushGrant(ctx context.Context, phoneID, grant, serviceURL string) error {
	params := store.SetPairedPhonePushGrantParams{ID: phoneID}
	if grant != "" {
		params.PushGrant = pgtype.Text{String: grant, Valid: true}
		params.PushServiceUrl = pgtype.Text{String: serviceURL, Valid: true}
	}
	if err := s.queries.SetPairedPhonePushGrant(ctx, params); err != nil {
		return fmt.Errorf("save push grant: %w", err)
	}
	return nil
}

// PushPreferences is what a phone wants to be told about.
type PushPreferences struct {
	Replies, Decisions, WhenActive bool
}

// SetPushPreferences records what a phone wants to be told about.
func (s *Service) SetPushPreferences(ctx context.Context, phoneID string, preferences PushPreferences) error {
	rows, err := s.queries.SetPairedPhonePushPreferences(ctx, store.SetPairedPhonePushPreferencesParams{
		ID: phoneID, PushReplies: preferences.Replies, PushDecisions: preferences.Decisions, PushWhenActive: preferences.WhenActive,
	})
	if err != nil {
		return fmt.Errorf("save push preferences: %w", err)
	}
	if rows == 0 {
		return mobilegateway.ErrUnknownPhone
	}
	return nil
}

func interval(d time.Duration) pgtype.Interval {
	return pgtype.Interval{Microseconds: d.Microseconds(), Valid: true}
}
