package externalsource

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/feishu"
)

// FeishuIMToolVersion is the one version of the Feishu IM tools TeamHub
// serves; the CLI pins it like a Composio toolkit version.
const FeishuIMToolVersion = "20261126_00"

// The Feishu IM tools. Their results are chats and messages in the CLI's
// shape, so the CLI does not decode Feishu's own.
const (
	FeishuIMListChats    = "FEISHU_IM_LIST_CHATS"
	FeishuIMListMessages = "FEISHU_IM_LIST_MESSAGES"
	FeishuIMGetMessage   = "FEISHU_IM_GET_MESSAGE"
	FeishuIMSendMessage  = "FEISHU_IM_SEND_MESSAGE"
	FeishuIMReplyMessage = "FEISHU_IM_REPLY_MESSAGE"
)

type feishuIMTool struct {
	name, description string
	parameters        map[string]any
}

var feishuIMTools = map[string]feishuIMTool{
	FeishuIMListChats: {"List Feishu chats", "List the group and topic chats the owner is a member of, newest first. A page continues from the previous page's next_page_token.", jsonSchemaObject([]string{"page_size"}, map[string]any{
		"page_size":  map[string]any{"type": "integer", "minimum": 1, "maximum": 100},
		"page_token": map[string]any{"type": "string", "minLength": 1},
	})},
	FeishuIMListMessages: {"List Feishu messages", "List a chat's messages newest first. A page continues from the previous page's next_page_token.", jsonSchemaObject([]string{"chat_id", "page_size"}, map[string]any{
		"chat_id":    idProperty,
		"page_size":  map[string]any{"type": "integer", "minimum": 1, "maximum": 50},
		"page_token": map[string]any{"type": "string", "minLength": 1},
	})},
	FeishuIMGetMessage: {"Read a Feishu message", "Read one message with its text and sender.", jsonSchemaObject([]string{"message_id"}, map[string]any{"message_id": idProperty})},
	FeishuIMSendMessage: {"Send a Feishu message", "Send a text message to a chat or a person. A send the owner must confirm waits for their card.", jsonSchemaObject([]string{"receive_id", "receive_id_type", "text"}, map[string]any{
		"receive_id":      idProperty,
		"receive_id_type": map[string]any{"enum": []any{"chat_id", "open_id", "user_id"}},
		"text":            map[string]any{"type": "string", "minLength": 1, "maxLength": 4096},
	})},
	FeishuIMReplyMessage: {"Reply to a Feishu message", "Reply in the thread of a message the owner can see.", jsonSchemaObject([]string{"message_id", "text"}, map[string]any{
		"message_id": idProperty,
		"text":       map[string]any{"type": "string", "minLength": 1, "maxLength": 4096},
	})},
}

// FeishuIMTools serves the Feishu IM tools to Agents through the same
// admission, confirmation and logging as Composio's tools.
type FeishuIMTools struct{ service *Service }

// FeishuIMTools returns the Feishu IM tool provider.
func (s *Service) FeishuIMTools() FeishuIMTools { return FeishuIMTools{service: s} }

// Toolkit is the toolkit slug Feishu connections record.
func (FeishuIMTools) Toolkit() string { return feishuToolkit }

// Owns reports whether slug is a Feishu IM tool.
func (FeishuIMTools) Owns(slug string) bool {
	_, ok := feishuIMTools[slug]
	return ok
}

// GetTool describes a tool at the one version TeamHub serves.
func (FeishuIMTools) GetTool(_ context.Context, slug, _ string) (composio.Tool, error) {
	definition, ok := feishuIMTools[slug]
	if !ok {
		return composio.Tool{}, ErrNotFound
	}
	tool := composio.Tool{Slug: slug, Name: definition.name, Description: definition.description, InputParameters: definition.parameters, Version: FeishuIMToolVersion}
	tool.Toolkit.Slug = feishuToolkit
	return tool, nil
}

// ConnectionStatus reports an Agent's active connection as active without a
// Computer call, which would add a lark-cli run to every tool call.
func (FeishuIMTools) ConnectionStatus(context.Context, string) (composio.ConnectionStatus, error) {
	return composio.ConnectionActive, nil
}

// ExecuteTool runs one call. Malformed arguments fail with ErrInvalid before
// Feishu is called; a refusal from Feishu is an unsuccessful execution with
// its reason, and anything else may have taken effect.
func (t FeishuIMTools) ExecuteTool(ctx context.Context, upstreamID, slug, version string, arguments map[string]any) (composio.ToolExecution, error) {
	if !t.Owns(slug) || version != FeishuIMToolVersion {
		return composio.ToolExecution{}, ErrNotFound
	}
	var data map[string]any
	client, err := t.service.feishuIMClient(ctx, upstreamID)
	if err == nil {
		call := feishuIMCall{client: client, args: arguments}
		data, err = call.run(ctx, slug)
	}
	var apiErr *feishu.APIError
	var computer *feishu.ComputerError
	switch {
	case err == nil:
		return composio.ToolExecution{Successful: true, Data: data}, nil
	case errors.Is(err, feishu.ErrIMIdentityChanged):
		// Before IsAuthFailure, which also claims this error.
		return refusal("lark-cli on the Computer that runs your Another Me is logged in to a different Feishu account than this connection, so nothing was read or sent. Log lark-cli back in to the connected account, or connect the other one."), nil
	case feishu.IsAuthFailure(err):
		// lark-cli refused before Feishu acted: the owner's login no longer works.
		return composio.ToolExecution{}, errors.Join(ErrNotActive, err)
	case errors.As(err, &apiErr):
		return refusal(fmt.Sprintf("Feishu refused the call (code %d): %s", apiErr.Code, apiErr.Message)), nil
	case errors.As(err, &computer) && computer.Status == feishu.StatusNotInstalled:
		return refusal("lark-cli is not installed on the Computer that runs your Another Me. Install it, sign in, and try again."), nil
	case errors.As(err, &computer) && computer.Status == feishu.StatusComputerOffline:
		return refusal("Feishu IM runs through lark-cli on the Computer that runs your Another Me, and that Computer is offline."), nil
	default:
		return composio.ToolExecution{}, err
	}
}

type feishuIMCall struct {
	client feishu.IM
	args   map[string]any
}

func (c feishuIMCall) run(ctx context.Context, slug string) (map[string]any, error) {
	switch slug {
	case FeishuIMListChats:
		page, err := c.client.ListChats(ctx, c.integer("page_size", 20), c.str("page_token"))
		if err != nil {
			return nil, err
		}
		items := make([]any, 0, len(page.Items))
		for _, chat := range page.Items {
			items = append(items, map[string]any{
				"chat_id": chat.ChatID, "name": chat.Name, "description": chat.Description,
				"chat_mode": chat.ChatMode, "chat_type": chat.ChatType,
			})
		}
		return withNextPage(map[string]any{"chats": items}, page.NextPageToken), nil
	case FeishuIMListMessages:
		page, err := c.client.ListMessages(ctx, c.str("chat_id"), c.integer("page_size", 20), c.str("page_token"))
		if err != nil {
			return nil, err
		}
		items := make([]any, 0, len(page.Items))
		for _, message := range page.Items {
			items = append(items, cliIMessage(message))
		}
		return withNextPage(map[string]any{"chat_id": c.str("chat_id"), "messages": items}, page.NextPageToken), nil
	case FeishuIMGetMessage:
		message, err := c.client.GetMessage(ctx, c.str("message_id"))
		if err != nil {
			return nil, err
		}
		return cliIMessage(message), nil
	case FeishuIMSendMessage:
		content, err := textContent(c.str("text"))
		if err != nil {
			return nil, err
		}
		messageID, err := c.client.SendMessage(ctx, c.str("receive_id"), c.str("receive_id_type"), "text", content)
		if err != nil {
			return nil, err
		}
		return map[string]any{"message_id": messageID, "sent": true}, nil
	case FeishuIMReplyMessage:
		content, err := textContent(c.str("text"))
		if err != nil {
			return nil, err
		}
		messageID, err := c.client.ReplyMessage(ctx, c.str("message_id"), "text", content)
		if err != nil {
			return nil, err
		}
		return map[string]any{"message_id": messageID, "sent": true}, nil
	}
	return nil, ErrNotFound
}

// textContent is the JSON content field Feishu's text messages carry.
func textContent(text string) (string, error) {
	encoded, err := json.Marshal(map[string]any{"text": text})
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

// withNextPage adds the page token a list result carries, so a caller can ask
// for the next page.
func withNextPage(result map[string]any, token string) map[string]any {
	if token != "" {
		result["next_page_token"] = token
	}
	return result
}

func cliIMessage(message feishu.IMMessage) map[string]any {
	return withoutEmpty(map[string]any{
		"message_id":  message.MessageID,
		"chat_id":     message.ChatID,
		"thread_id":   message.ThreadID,
		"msg_type":    message.MsgType,
		"sender_id":   message.Sender.ID,
		"sender_type": message.Sender.SenderType,
		"create_time": message.CreateTime,
		"text":        decodedText(message.Body.Content),
	})
}

func (c feishuIMCall) str(name string) string {
	value, _ := c.args[name].(string)
	return value
}

func (c feishuIMCall) integer(name string, fallback int) int {
	switch number := c.args[name].(type) {
	case float64:
		return int(number)
	case int:
		return number
	case json.Number:
		parsed, _ := number.Int64()
		return int(parsed)
	}
	return fallback
}
