package feishu

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

// imAPIPath is the owner's own IM, the only API prefix a Computer runs.
const imAPIPath = "/open-apis/im/v1"

// imIdentityPath is the owner's own user profile, the one call outside the IM
// prefix: it names the account a connection is bound to.
const imIdentityPath = "/open-apis/authen/v1/user_info"

// ErrIMIdentityChanged reports an owner's lark-cli logged in to another Feishu
// user than the one the connection was authorized for: nothing is read or sent.
var ErrIMIdentityChanged = errors.New("the owner's lark-cli is logged in to another Feishu account")

// imIdentity is the account an IM is bound to and the outcome of checking it,
// shared by the copies of one IM.
type imIdentity struct {
	openID string
	once   sync.Once
	err    error
}

// IM is one owner's Feishu IM, reached through their lark-cli. It reads and
// sends messages in the chats the owner is a member of; TeamHub keeps no
// Feishu credentials.
type IM struct {
	call     Caller
	identity *imIdentity
}

// NewIM builds an IM.
func NewIM(call Caller) IM { return IM{call: call} }

// BoundTo binds the IM to openID, the account its connection was authorized
// for. lark-cli acts as whoever is logged in to it now, so the first call
// checks that this is still openID and every call fails with
// ErrIMIdentityChanged when it is not.
func (m IM) BoundTo(openID string) IM {
	m.identity = &imIdentity{openID: strings.ToLower(strings.TrimSpace(openID))}
	return m
}

// checkIdentity reads the logged-in account once and compares it with the bound
// one. The outcome is cached for every copy of this IM, so a profile the
// Computer cannot read fails every call rather than blocking only the first.
func (m IM) checkIdentity(ctx context.Context) error {
	if m.identity == nil || m.identity.openID == "" {
		return nil
	}
	m.identity.once.Do(func() {
		identity, err := m.Identity(ctx)
		if err == nil && identity.OpenID != m.identity.openID {
			err = ErrIMIdentityChanged
		}
		m.identity.err = err
	})
	return m.identity.err
}

// Identity is the Feishu account the owner's lark-cli is logged in to.
type Identity struct {
	OpenID string
	Name   string
}

// Identity reads the owner's own user profile.
func (m IM) Identity(ctx context.Context) (Identity, error) {
	var result struct {
		Data struct {
			OpenID string `json:"open_id"`
			Name   string `json:"name"`
		} `json:"data"`
	}
	if err := m.request(ctx, "read user", "GET", imIdentityPath, nil, nil, &result); err != nil {
		return Identity{}, err
	}
	if result.Data.OpenID == "" {
		return Identity{}, &ComputerError{Status: "failed", Detail: "lark-cli reported no Feishu account"}
	}
	return Identity{OpenID: strings.ToLower(strings.TrimSpace(result.Data.OpenID)), Name: result.Data.Name}, nil
}

// do sends one IM API request after checking that lark-cli is still logged in
// to the bound account.
func (m IM) do(ctx context.Context, operation, method, path string, query map[string]any, body any, result any) error {
	if err := m.checkIdentity(ctx); err != nil {
		return err
	}
	return m.request(ctx, operation, method, path, query, body, result)
}

// request sends one IM API request, path relative to the IM prefix (or an
// absolute /open-apis path), and decodes a successful response's data into
// result's Data field. It does not check the bound identity, so the identity
// read itself cannot recurse.
func (m IM) request(ctx context.Context, operation, method, path string, query map[string]any, body any, result any) error {
	requestPath := imAPIPath
	if path != "" {
		requestPath = imAPIPath + "/" + path
		if strings.HasPrefix(path, "/open-apis/") {
			requestPath = path
		}
	}
	arguments := map[string]any{"method": method, "path": requestPath}
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

// Status checks that the owner's lark-cli is logged in with every IM scope.
func (m IM) Status(ctx context.Context) error {
	result, err := m.call(ctx, "status", map[string]any{})
	if err != nil {
		return err
	}
	return statusError("status check", result)
}

// StartLogin starts a lark-cli login for the IM scopes on the owner's
// Computer, named id. The Computer keeps its device code.
func (m IM) StartLogin(ctx context.Context, id string) (Login, error) {
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
	return Login{URL: link, ExpiresAt: time.Now().UTC().Add(time.Duration(expiresIn) * time.Second)}, nil
}

// WaitLogin waits a while for the login named id to finish.
func (m IM) WaitLogin(ctx context.Context, id string) (LoginState, error) {
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

// Chat is one Feishu group or topic chat the owner is a member of.
type Chat struct {
	ChatID      string `json:"chat_id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	ChatMode    string `json:"chat_mode"`
	ChatType    string `json:"chat_type"`
	OwnerID     string `json:"owner_id"`
}

// IMMessage is one Feishu message.
type IMMessage struct {
	MessageID  string `json:"message_id"`
	RootID     string `json:"root_id"`
	ParentID   string `json:"parent_id"`
	ThreadID   string `json:"thread_id"`
	MsgType    string `json:"msg_type"`
	CreateTime string `json:"create_time"`
	UpdateTime string `json:"update_time"`
	ChatID     string `json:"chat_id"`
	Sender     struct {
		ID         string `json:"id"`
		IDType     string `json:"id_type"`
		SenderType string `json:"sender_type"`
	} `json:"sender"`
	Body struct {
		Content string `json:"content"`
	} `json:"body"`
}

// ChatPage is one page of the chats the owner is a member of.
type ChatPage struct {
	Items         []Chat
	NextPageToken string
}

// ListChats returns one page of the chats the owner is a member of. A
// non-empty pageToken continues from the previous page.
func (m IM) ListChats(ctx context.Context, limit int, pageToken string) (ChatPage, error) {
	query := map[string]any{"sort_type": "ByActiveTimeDesc"}
	if limit > 0 {
		query["page_size"] = limit
	}
	if pageToken != "" {
		query["page_token"] = pageToken
	}
	var result struct {
		Data struct {
			Items     []Chat `json:"items"`
			PageToken string `json:"page_token"`
		} `json:"data"`
	}
	if err := m.do(ctx, "list chats", "GET", "chats", query, nil, &result); err != nil {
		return ChatPage{}, err
	}
	return ChatPage{Items: result.Data.Items, NextPageToken: result.Data.PageToken}, nil
}

// MessagePage is one page of a chat's messages.
type MessagePage struct {
	Items         []IMMessage
	NextPageToken string
}

// ListMessages returns one page of a chat's messages, newest first. chatID is
// a chat_id; a page continues from the previous page's token.
func (m IM) ListMessages(ctx context.Context, chatID string, limit int, pageToken string) (MessagePage, error) {
	if strings.TrimSpace(chatID) == "" {
		return MessagePage{}, &APIError{Operation: "list messages", Message: "a chat is required"}
	}
	query := map[string]any{"container_id": chatID, "container_id_type": "chat", "sort_type": "ByCreateTimeDesc"}
	if limit > 0 {
		query["page_size"] = limit
	}
	if pageToken != "" {
		query["page_token"] = pageToken
	}
	var result struct {
		Data struct {
			Items     []IMMessage `json:"items"`
			PageToken string      `json:"page_token"`
		} `json:"data"`
	}
	if err := m.do(ctx, "list messages", "GET", "messages", query, nil, &result); err != nil {
		return MessagePage{}, err
	}
	return MessagePage{Items: result.Data.Items, NextPageToken: result.Data.PageToken}, nil
}

// GetMessage returns one message by ID.
func (m IM) GetMessage(ctx context.Context, messageID string) (IMMessage, error) {
	var result struct {
		Data struct {
			Items []IMMessage `json:"items"`
		} `json:"data"`
	}
	if err := m.do(ctx, "get message", "GET", "messages/"+messageID, nil, nil, &result); err != nil {
		return IMMessage{}, err
	}
	if len(result.Data.Items) == 0 {
		return IMMessage{}, &APIError{Operation: "get message", Subtype: "not_found"}
	}
	return result.Data.Items[0], nil
}

// SendMessage sends a message to a chat or a user and returns its message ID.
// receiveIDType is chat_id, open_id or user_id.
func (m IM) SendMessage(ctx context.Context, receiveID, receiveIDType, msgType, content string) (string, error) {
	body := map[string]any{"receive_id": receiveID, "msg_type": msgType, "content": content}
	var result struct {
		Data struct {
			MessageID string `json:"message_id"`
		} `json:"data"`
	}
	query := map[string]any{"receive_id_type": receiveIDType}
	if err := m.do(ctx, "send message", "POST", "messages", query, body, &result); err != nil {
		return "", err
	}
	if result.Data.MessageID == "" {
		return "", &ComputerError{Status: "failed", Detail: "Feishu sent no message ID"}
	}
	return result.Data.MessageID, nil
}

// ReplyMessage replies to a message and returns the reply's message ID.
func (m IM) ReplyMessage(ctx context.Context, messageID, msgType, content string) (string, error) {
	body := map[string]any{"msg_type": msgType, "content": content}
	var result struct {
		Data struct {
			MessageID string `json:"message_id"`
		} `json:"data"`
	}
	if err := m.do(ctx, "reply message", "POST", "messages/"+messageID+"/reply", nil, body, &result); err != nil {
		return "", err
	}
	if result.Data.MessageID == "" {
		return "", &ComputerError{Status: "failed", Detail: "Feishu sent no reply ID"}
	}
	return result.Data.MessageID, nil
}
