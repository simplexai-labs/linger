// Package feishu reads and sends Feishu Mail for the connected app TeamHub
// runs itself, without Composio. Every call goes to the mailbox owner's own
// lark-cli on their Computer, which holds their Feishu login: TeamHub keeps
// no Feishu credentials and needs no Feishu app of its own.
package feishu

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
)

// mailboxPath is the owner's own mailbox, the only API path a Computer runs.
const mailboxPath = "/open-apis/mail/v1/user_mailboxes/me"

// Caller runs one Feishu Mail tool on the Computer of a mailbox's owner and
// returns its result, whatever its status. An error means no result came
// back: no Computer was reachable, or it may have acted without answering.
type Caller func(ctx context.Context, tool string, arguments map[string]any) (map[string]any, error)

// Mailbox is one owner's Feishu mailbox, reached through their lark-cli.
type Mailbox struct {
	call      Caller
	downloads *http.Client
	identity  *mailboxIdentity
}

// mailboxIdentity is the address a Mailbox is bound to and the outcome of
// checking it, shared by the copies of one Mailbox.
type mailboxIdentity struct {
	address string
	once    sync.Once
	err     error
}

// NewMailbox builds a Mailbox. downloads fetches the presigned attachment
// links Feishu hands out, which need no login.
func NewMailbox(call Caller, downloads *http.Client) Mailbox {
	return Mailbox{call: call, downloads: downloads}
}

// BoundTo binds the Mailbox to address, the mailbox its connection was
// authorized for. lark-cli acts as whoever is logged in to it now, so the
// first call checks that this is still address and every call fails with
// ErrMailboxChanged when it is not.
func (m Mailbox) BoundTo(address string) Mailbox {
	m.identity = &mailboxIdentity{address: strings.ToLower(strings.TrimSpace(address))}
	return m
}

// checkIdentity reads the logged-in mailbox once and compares it with the
// bound address.
func (m Mailbox) checkIdentity(ctx context.Context) error {
	if m.identity == nil || m.identity.address == "" {
		return nil
	}
	m.identity.once.Do(func() {
		address, err := m.Address(ctx)
		if err == nil && address != m.identity.address {
			err = ErrMailboxChanged
		}
		m.identity.err = err
	})
	return m.identity.err
}

// APIError is a refusal of the Feishu Open Platform that lark-cli relayed,
// with the platform's numeric code and lark-cli's error subtype, such as
// not_found. Message is lark-cli's text, kept for logs and the Agent only.
type APIError struct {
	Operation string
	Code      int
	Subtype   string
	Message   string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("Feishu %s failed: code=%d", e.Operation, e.Code)
}

// RateLimitError reports a call the Open Platform throttled.
type RateLimitError struct {
	Operation  string
	RetryAfter time.Duration
}

func (e *RateLimitError) Error() string { return "Feishu " + e.Operation + " was rate limited" }

// ComputerError reports a call that did not get Feishu's answer: no Computer
// of the owner was online, lark-cli is not installed there, or the Computer
// did not confirm the result. Status is the Computer's status code.
type ComputerError struct {
	Status string
	Detail string
}

func (e *ComputerError) Error() string { return "the Feishu Mail Computer call failed: " + e.Status }

// Computer statuses that carry their own meaning.
const (
	// StatusNotInstalled is a Computer without lark-cli.
	StatusNotInstalled = "not_installed"
	// StatusComputerOffline is an owner with no online Computer running their
	// AnotherMe.
	StatusComputerOffline = "computer_offline"
	// StatusNotConfigured is a lark-cli never set up with a Feishu app, which
	// no login can fix.
	StatusNotConfigured = "not_configured"
)

// The commands that install lark-cli and set it up with a Feishu app on the
// owner's Computer. The Web receives the command for the current setup step.
const (
	InstallCommand = "npm install -g @larksuite/cli"
	SetupCommand   = "lark-cli config init --new"
)

// ErrAuthorizationRequired reports an owner whose lark-cli is not logged in
// to Feishu, or whose login no longer works.
var ErrAuthorizationRequired = errors.New("the owner's lark-cli needs a Feishu login")

// ErrMailboxChanged reports an owner's lark-cli logged in to another mailbox
// than the one the connection was authorized for: nothing is read or sent.
var ErrMailboxChanged = errors.New("the owner's lark-cli is logged in to another Feishu mailbox")

// ScopesMissingError reports a lark-cli login without every mail scope.
// NotEnabled are the scopes its Feishu app does not enable at all: logging in
// again cannot grant those until the app's console enables them. AppID and
// Brand name that app, when lark-cli reported them.
type ScopesMissingError struct {
	Scopes     []string
	NotEnabled []string
	AppID      string
	Brand      string
}

// appIDPattern is the shape of an Open Platform app ID, which a console URL
// may carry.
var appIDPattern = regexp.MustCompile(`^cli_[A-Za-z0-9]{1,64}$`)

// PermissionsURL is the permissions page of the lark-cli app in its
// developer console, or empty when the app is unknown.
func (e *ScopesMissingError) PermissionsURL() string {
	if !appIDPattern.MatchString(e.AppID) {
		return ""
	}
	console := "https://open.feishu.cn"
	if e.Brand == "lark" {
		console = "https://open.larksuite.com"
	}
	return console + "/app/" + e.AppID + "/auth"
}

func (e *ScopesMissingError) Error() string {
	return "the lark-cli login lacks Feishu Mail scopes: " + strings.Join(e.Scopes, " ")
}

// Platform codes that mean the user's authorization no longer works: the
// refresh token was revoked or already used, the yearly reauthorization is
// due, the access token is invalid or expired, or it lacks a scope.
var authFailureCodes = []int{20037, 20064, 20073, 99991668, 99991677, 99991679}

// rateLimitCode is the Open Platform's request frequency limit.
const rateLimitCode = 99991400

// IsAuthFailure reports whether err means the owner must log in again.
func IsAuthFailure(err error) bool {
	var scopes *ScopesMissingError
	var apiErr *APIError
	return errors.Is(err, ErrAuthorizationRequired) || errors.Is(err, ErrMailboxChanged) || errors.As(err, &scopes) ||
		errors.As(err, &apiErr) && slices.Contains(authFailureCodes, apiErr.Code)
}

// IsNotFound reports a refusal because the message or draft does not exist.
func IsNotFound(err error) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.Subtype == "not_found"
}

// IsComputerFailure reports whether err means Feishu never answered.
func IsComputerFailure(err error) bool {
	var computer *ComputerError
	return errors.As(err, &computer)
}

// do sends one mail API request, path relative to the mailbox, and decodes a
// successful response's data into result's Data field. A bound Mailbox first
// checks that lark-cli is still logged in to its mailbox.
func (m Mailbox) do(ctx context.Context, operation, method, path string, query map[string]any, body any, result any) error {
	if err := m.checkIdentity(ctx); err != nil {
		return err
	}
	return m.request(ctx, operation, method, path, query, body, result)
}

// request sends one mail API request without the identity check.
func (m Mailbox) request(ctx context.Context, operation, method, path string, query map[string]any, body any, result any) error {
	arguments := map[string]any{"method": method, "path": mailboxPath}
	if path != "" {
		arguments["path"] = mailboxPath + "/" + path
	}
	if len(query) > 0 {
		arguments["params"] = query
	}
	if body != nil {
		arguments["data"] = body
	}
	response, err := m.call(ctx, "api", arguments)
	if err != nil {
		return err
	}
	if err = statusError(operation, response); err != nil {
		return err
	}
	if result == nil {
		return nil
	}
	encoded, err := json.Marshal(map[string]any{"data": response["data"]})
	if err != nil {
		return err
	}
	if err = json.Unmarshal(encoded, result); err != nil {
		return fmt.Errorf("decode Feishu %s response: %w", operation, err)
	}
	return nil
}

// statusError turns a tool result that is not ok into its error. lark-cli
// reports a platform refusal with its code; anything else never reached
// Feishu or did not come back.
func statusError(operation string, result map[string]any) error {
	status, _ := result["status"].(string)
	detail, _ := result["detail"].(string)
	switch status {
	case "ok":
		return nil
	case "missing_scope":
		appID, _ := result["app_id"].(string)
		brand, _ := result["brand"].(string)
		return &ScopesMissingError{Scopes: stringList(result["missing_scopes"]), NotEnabled: stringList(result["app_missing_scopes"]), AppID: appID, Brand: brand}
	case "auth_required":
		return ErrAuthorizationRequired
	case "failed":
		code := integer(result["code"])
		subtype, _ := result["error_subtype"].(string)
		switch {
		case code == rateLimitCode || subtype == "rate_limited":
			return &RateLimitError{Operation: operation, RetryAfter: time.Minute}
		case code != 0 || subtype == "not_found":
			return &APIError{Operation: operation, Code: code, Subtype: subtype, Message: detail}
		}
	}
	if status == "" {
		status = "failed"
	}
	return &ComputerError{Status: status, Detail: detail}
}

// Status checks that the owner's lark-cli is logged in with every mail scope
// and returns the address of the mailbox, the identity of a connection.
func (m Mailbox) Status(ctx context.Context) (string, error) {
	result, err := m.call(ctx, "status", map[string]any{})
	if err != nil {
		return "", err
	}
	if err = statusError("status check", result); err != nil {
		return "", err
	}
	address, _ := result["address"].(string)
	if address = strings.ToLower(strings.TrimSpace(address)); address == "" {
		return "", &ComputerError{Status: "failed", Detail: "lark-cli reported no mailbox address"}
	}
	if m.identity != nil && m.identity.address != "" && address != m.identity.address {
		return "", ErrMailboxChanged
	}
	return address, nil
}

// Login is a lark-cli login its owner finishes on Feishu's page.
type Login struct {
	URL       string
	ExpiresAt time.Time
}

// StartLogin starts a lark-cli login for the mail scopes on the owner's
// Computer, named id. The Computer keeps its device code.
func (m Mailbox) StartLogin(ctx context.Context, id string) (Login, error) {
	result, err := m.call(ctx, "login_start", map[string]any{"login_id": id})
	if err != nil {
		return Login{}, err
	}
	if err = statusError("login", result); err != nil {
		return Login{}, err
	}
	link, _ := result["verification_url"].(string)
	expiresIn := integer(result["expires_in"])
	if link == "" || expiresIn <= 0 {
		return Login{}, &ComputerError{Status: "failed", Detail: "lark-cli started no login"}
	}
	return Login{URL: link, ExpiresAt: time.Now().Add(time.Duration(expiresIn) * time.Second)}, nil
}

// LoginState is where a started login stands.
type LoginState int

// The states of a started login.
const (
	// LoginDone is a login the owner finished.
	LoginDone LoginState = iota
	// LoginPending is a login still waiting for the owner.
	LoginPending
	// LoginGone is a login the Computer no longer holds: it expired, failed,
	// finished earlier, or was never started there.
	LoginGone
)

// WaitLogin waits a while for the login named id to finish.
func (m Mailbox) WaitLogin(ctx context.Context, id string) (LoginState, error) {
	result, err := m.call(ctx, "login_wait", map[string]any{"login_id": id})
	if err != nil {
		return LoginGone, err
	}
	switch status, _ := result["status"].(string); status {
	case "ok":
		return LoginDone, nil
	case "pending":
		return LoginPending, nil
	case "expired", "login_failed":
		return LoginGone, nil
	}
	return LoginGone, statusError("login", result)
}

func stringList(value any) []string {
	items, _ := value.([]any)
	list := make([]string, 0, len(items))
	for _, item := range items {
		if text, ok := item.(string); ok && text != "" {
			list = append(list, text)
		}
	}
	return list
}

func integer(value any) int {
	switch number := value.(type) {
	case float64:
		return int(number)
	case int:
		return number
	case int64:
		return int(number)
	case json.Number:
		parsed, _ := number.Int64()
		return int(parsed)
	}
	return 0
}
