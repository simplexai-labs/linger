package composio

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

type DiscordIdentity struct {
	GuildID, GuildName string
}

var (
	ErrDiscordGuildRequired      = errors.New("Discord server must be selected")
	ErrDiscordGuildNotAccessible = errors.New("Discord server is not accessible")
	// ErrDiscordToolRefused marks a Discord tool execution that Composio
	// reported unsuccessful without a status code, so callers can tell a
	// refusal from a transient failure without reading its text.
	ErrDiscordToolRefused = errors.New("Discord tool execution was refused")
	// ErrDiscordChannelGuildUnknown marks a channel lookup that succeeded but
	// did not name the channel's server.
	ErrDiscordChannelGuildUnknown = errors.New("Discord channel response was incomplete")
)

type DiscordChannel struct {
	ID, GuildID, ParentID, Name string
	Type                        int
	ArchivedAt                  time.Time
}

type DiscordThreadPage struct {
	Threads    []DiscordChannel
	NextCursor string
}

type DiscordAttachment struct {
	ID, Filename, URL string
}

type DiscordMessage struct {
	ID, ChannelID, ParentChannelID, ChannelName, ThreadName string
	Content, AuthorID, AuthorName                           string
	Timestamp, EditedTimestamp                              time.Time
	Type                                                    int
	AuthorBot                                               bool
	Attachments                                             []DiscordAttachment
}

type DiscordMessagePage struct {
	Messages   []DiscordMessage
	NextBefore string
}

// Discord tools are pinned so a TeamHub release keeps its behavior when
// Composio publishes a new tool version. Composio disables Proxy Execute for
// discordbot, so every Discord read goes through these tools.
const discordToolVersion = "20261116_00"

// executeDiscordTool runs a read-only Discord tool for the bound user and
// decodes its data into target. A failed execution is classified only by the
// structured data.status_code, never by the error prose.
func (c *Client) executeDiscordTool(ctx context.Context, connectedAccountID, slug string, arguments map[string]any, target any, operation string) error {
	binding, err := c.authorizeConnection(ctx, connectedAccountID)
	if err != nil {
		return err
	}
	request := struct {
		ConnectedAccountID string         `json:"connected_account_id"`
		UserID             string         `json:"user_id"`
		Version            string         `json:"version"`
		Arguments          map[string]any `json:"arguments"`
	}{ConnectedAccountID: connectedAccountID, UserID: binding.UserID, Version: discordToolVersion, Arguments: arguments}
	var response struct {
		Data       json.RawMessage `json:"data"`
		Successful bool            `json:"successful"`
	}
	endpoint := "/api/v3.1/tools/execute/" + url.PathEscape(slug)
	if err := c.requestJSON(ctx, http.MethodPost, endpoint, request, &response, operation); err != nil {
		return err
	}
	if !response.Successful {
		var failure struct {
			StatusCode int `json:"status_code"`
		}
		_ = decodeDiscordToolData(response.Data, &failure)
		switch {
		case failure.StatusCode == http.StatusTooManyRequests:
			return &RateLimitError{Operation: operation, Source: ErrorSourceProvider}
		case failure.StatusCode > 0:
			return &remoteError{operation: operation, status: failure.StatusCode, source: ErrorSourceProvider}
		default:
			return fmt.Errorf("Composio %s failed: %w", operation, ErrDiscordToolRefused)
		}
	}
	if err := decodeDiscordToolData(response.Data, target); err != nil {
		return fmt.Errorf("Composio %s returned an invalid response", operation)
	}
	return nil
}

// decodeDiscordToolData accepts data as an object or as a string holding an
// object: Composio documents a string, but the live tools return objects.
func decodeDiscordToolData(data json.RawMessage, target any) error {
	payload := data
	if len(payload) > 0 && payload[0] == '"' {
		var encoded string
		if err := json.Unmarshal(payload, &encoded); err != nil {
			return err
		}
		payload = []byte(strings.TrimSpace(encoded))
	}
	if len(payload) == 0 || payload[0] != '{' {
		return errors.New("Discord tool data was not an object")
	}
	return json.Unmarshal(payload, target)
}

// IdentifyDiscord returns the server the bot connection was installed in. It
// fails closed with ErrDiscordGuildRequired unless Composio reports a valid
// server id and a readable name.
func (c *Client) IdentifyDiscord(ctx context.Context, connectedAccountID string) (DiscordIdentity, error) {
	var guild struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err := c.executeDiscordTool(ctx, connectedAccountID, "DISCORDBOT_GET_CONNECTED_GUILD", map[string]any{}, &guild, "identify Discord installation"); err != nil {
		return DiscordIdentity{}, err
	}
	name := strings.TrimSpace(guild.Name)
	if !validDiscordGuildID(guild.ID) || name == "" || strings.EqualFold(name, "REDACTED") {
		return DiscordIdentity{}, ErrDiscordGuildRequired
	}
	return DiscordIdentity{GuildID: guild.ID, GuildName: name}, nil
}

// validDiscordGuildID accepts only Discord snowflakes so a redacted or
// malformed value never becomes a bound identity.
func validDiscordGuildID(id string) bool {
	if len(id) < 17 || len(id) > 20 {
		return false
	}
	for _, r := range id {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func (c *Client) GetDiscordGuild(ctx context.Context, connectedAccountID, guildID string) (DiscordIdentity, error) {
	if guildID == "" {
		return DiscordIdentity{}, errors.New("Discord guild id is required")
	}
	var wire struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err := c.executeDiscordTool(ctx, connectedAccountID, "DISCORDBOT_GET_GUILD", map[string]any{"guild_id": guildID}, &wire, "get Discord guild"); err != nil {
		var remote *remoteError
		if errors.As(err, &remote) && (remote.status == http.StatusForbidden || remote.status == http.StatusNotFound) {
			return DiscordIdentity{}, ErrDiscordGuildNotAccessible
		}
		return DiscordIdentity{}, err
	}
	if wire.ID != guildID || strings.TrimSpace(wire.Name) == "" {
		return DiscordIdentity{}, errors.New("Discord guild response was incomplete")
	}
	return DiscordIdentity{GuildID: wire.ID, GuildName: wire.Name}, nil
}

// GetDiscordChannelGuild returns the server a channel or thread belongs to.
// A response without a string guild_id fails with
// ErrDiscordChannelGuildUnknown.
func (c *Client) GetDiscordChannelGuild(ctx context.Context, connectedAccountID, channelID string) (string, error) {
	if channelID == "" {
		return "", errors.New("Discord channel id is required")
	}
	var wire struct {
		GuildID any `json:"guild_id"`
	}
	if err := c.executeDiscordTool(ctx, connectedAccountID, "DISCORDBOT_GET_CHANNEL", map[string]any{"channel_id": channelID}, &wire, "get Discord channel"); err != nil {
		return "", err
	}
	guildID, _ := wire.GuildID.(string)
	if guildID == "" {
		return "", ErrDiscordChannelGuildUnknown
	}
	return guildID, nil
}

func (c *Client) ListDiscordChannels(ctx context.Context, connectedAccountID, guildID string) ([]DiscordChannel, error) {
	var wire struct {
		Channels []struct {
			ID       string `json:"id"`
			GuildID  string `json:"guild_id"`
			ParentID string `json:"parent_id"`
			Name     string `json:"name"`
			Type     int    `json:"type"`
		} `json:"channels"`
	}
	if err := c.executeDiscordTool(ctx, connectedAccountID, "DISCORDBOT_LIST_GUILD_CHANNELS", map[string]any{"guild_id": guildID}, &wire, "list Discord guild channels"); err != nil {
		return nil, err
	}
	channels := make([]DiscordChannel, 0, len(wire.Channels))
	for _, item := range wire.Channels {
		if item.ID == "" || item.GuildID != guildID || strings.TrimSpace(item.Name) == "" {
			return nil, errors.New("Discord channel response was incomplete")
		}
		if item.Type == 0 || item.Type == 5 || item.Type == 15 || item.Type == 16 {
			channels = append(channels, DiscordChannel{ID: item.ID, GuildID: item.GuildID, ParentID: item.ParentID, Name: item.Name, Type: item.Type})
		}
	}
	return channels, nil
}

func (c *Client) ListDiscordActiveThreads(ctx context.Context, connectedAccountID, guildID string) ([]DiscordChannel, error) {
	var wire struct {
		Threads []discordThreadWire `json:"threads"`
	}
	if err := c.executeDiscordTool(ctx, connectedAccountID, "DISCORDBOT_GET_ACTIVE_GUILD_THREADS", map[string]any{"guild_id": guildID}, &wire, "list active Discord threads"); err != nil {
		return nil, err
	}
	return normalizeDiscordThreads(guildID, wire.Threads)
}

func (c *Client) ListDiscordArchivedThreads(ctx context.Context, connectedAccountID, guildID, channelID, cursor string, limit int) (DiscordThreadPage, error) {
	if guildID == "" || channelID == "" || limit < 1 || limit > 100 {
		return DiscordThreadPage{}, errors.New("invalid Discord archived thread request")
	}
	arguments := map[string]any{"channel_id": channelID, "limit": limit}
	if cursor != "" {
		arguments["before"] = cursor
	}
	var wire struct {
		Threads []discordThreadWire `json:"threads"`
		HasMore bool                `json:"has_more"`
	}
	if err := c.executeDiscordTool(ctx, connectedAccountID, "DISCORDBOT_LIST_PUBLIC_ARCHIVED_THREADS", arguments, &wire, "list archived Discord threads"); err != nil {
		return DiscordThreadPage{}, err
	}
	threads, err := normalizeDiscordThreads(guildID, wire.Threads)
	if err != nil {
		return DiscordThreadPage{}, err
	}
	for _, thread := range threads {
		if thread.ArchivedAt.IsZero() {
			return DiscordThreadPage{}, errors.New("Discord archived thread timestamp was missing")
		}
	}
	page := DiscordThreadPage{Threads: threads}
	if wire.HasMore {
		if len(wire.Threads) == 0 || wire.Threads[len(wire.Threads)-1].ThreadMetadata.ArchiveTimestamp == "" {
			return DiscordThreadPage{}, errors.New("Discord archived thread cursor was missing")
		}
		page.NextCursor = wire.Threads[len(wire.Threads)-1].ThreadMetadata.ArchiveTimestamp
	}
	return page, nil
}

type discordThreadWire struct {
	ID             string `json:"id"`
	GuildID        string `json:"guild_id"`
	ParentID       string `json:"parent_id"`
	Name           string `json:"name"`
	Type           int    `json:"type"`
	ThreadMetadata struct {
		ArchiveTimestamp string `json:"archive_timestamp"`
	} `json:"thread_metadata"`
}

func normalizeDiscordThreads(guildID string, wire []discordThreadWire) ([]DiscordChannel, error) {
	threads := make([]DiscordChannel, 0, len(wire))
	for _, item := range wire {
		if item.ID == "" || item.GuildID != guildID || item.ParentID == "" || strings.TrimSpace(item.Name) == "" || item.Type < 10 || item.Type > 12 {
			return nil, errors.New("Discord thread response was incomplete")
		}
		var archivedAt time.Time
		if item.ThreadMetadata.ArchiveTimestamp != "" {
			var err error
			archivedAt, err = time.Parse(time.RFC3339Nano, item.ThreadMetadata.ArchiveTimestamp)
			if err != nil {
				return nil, errors.New("Discord archived thread timestamp was invalid")
			}
			archivedAt = archivedAt.UTC()
		}
		threads = append(threads, DiscordChannel{ID: item.ID, GuildID: item.GuildID, ParentID: item.ParentID, Name: item.Name, Type: item.Type, ArchivedAt: archivedAt})
	}
	return threads, nil
}

func (c *Client) ListDiscordMessages(ctx context.Context, connectedAccountID, channelID, before string, limit int) (DiscordMessagePage, error) {
	if channelID == "" || limit < 1 || limit > 100 {
		return DiscordMessagePage{}, errors.New("invalid Discord message page request")
	}
	arguments := map[string]any{"channel_id": channelID, "limit": limit}
	if before != "" {
		arguments["before"] = before
	}
	var envelope struct {
		Messages []discordMessageWire `json:"messages"`
	}
	if err := c.executeDiscordTool(ctx, connectedAccountID, "DISCORDBOT_LIST_MESSAGES", arguments, &envelope, "list Discord messages"); err != nil {
		return DiscordMessagePage{}, err
	}
	wire := envelope.Messages
	page := DiscordMessagePage{}
	for _, item := range wire {
		timestamp, err := time.Parse(time.RFC3339Nano, item.Timestamp)
		if err != nil || item.ID == "" || item.ChannelID != channelID || item.Author.ID == "" {
			return DiscordMessagePage{}, errors.New("Discord message response was incomplete")
		}
		authorName := item.Member.Nick
		if strings.TrimSpace(authorName) == "" {
			authorName = item.Author.GlobalName
		}
		if strings.TrimSpace(authorName) == "" {
			authorName = item.Author.Username
		}
		message := DiscordMessage{ID: item.ID, ChannelID: item.ChannelID, Content: item.Content, AuthorID: item.Author.ID, AuthorName: authorName, AuthorBot: item.Author.Bot, Timestamp: timestamp.UTC(), Type: item.Type}
		if item.EditedTimestamp != "" {
			edited, parseErr := time.Parse(time.RFC3339Nano, item.EditedTimestamp)
			if parseErr != nil {
				return DiscordMessagePage{}, errors.New("Discord edited timestamp was invalid")
			}
			message.EditedTimestamp = edited.UTC()
		}
		for _, attachment := range item.Attachments {
			message.Attachments = append(message.Attachments, DiscordAttachment{ID: attachment.ID, Filename: attachment.Filename, URL: attachment.URL})
		}
		page.Messages = append(page.Messages, message)
	}
	if len(wire) == limit && len(wire) > 0 {
		page.NextBefore = wire[len(wire)-1].ID
	}
	return page, nil
}

type discordMessageWire struct {
	ID              string `json:"id"`
	ChannelID       string `json:"channel_id"`
	Content         string `json:"content"`
	Timestamp       string `json:"timestamp"`
	EditedTimestamp string `json:"edited_timestamp"`
	Type            int    `json:"type"`
	Author          struct {
		ID         string `json:"id"`
		Username   string `json:"username"`
		GlobalName string `json:"global_name"`
		Bot        bool   `json:"bot"`
	} `json:"author"`
	Member struct {
		Nick string `json:"nick"`
	} `json:"member"`
	Attachments []struct {
		ID       string `json:"id"`
		Filename string `json:"filename"`
		URL      string `json:"url"`
	} `json:"attachments"`
}

func RenderDiscordDocumentsWithLimits(identity DiscordIdentity, channels map[string]DiscordChannel, messages []DiscordMessage, limits AppImportLimits) ([]AppDocument, error) {
	type groupKey struct{ channelID, day string }
	grouped := map[groupKey][]DiscordMessage{}
	for _, message := range messages {
		parentID := message.ParentChannelID
		if parentID == "" {
			parentID = message.ChannelID
		}
		if channels[parentID].ID == "" || message.ID == "" || message.Timestamp.IsZero() {
			return nil, errors.New("Discord message did not match a selected channel")
		}
		if strings.TrimSpace(message.Content) == "" && len(message.Attachments) == 0 {
			continue
		}
		day := message.Timestamp.UTC().Format("2006-01-02")
		grouped[groupKey{channelID: parentID, day: day}] = append(grouped[groupKey{channelID: parentID, day: day}], message)
	}
	keys := make([]groupKey, 0, len(grouped))
	for key := range grouped {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i].channelID+keys[i].day < keys[j].channelID+keys[j].day })
	documents := make([]AppDocument, 0, len(keys))
	renderedTotal := 0
	for _, key := range keys {
		channel := channels[key.channelID]
		sort.SliceStable(grouped[key], func(i, j int) bool { return grouped[key][i].Timestamp.Before(grouped[key][j].Timestamp) })
		output := newAppDocumentBuilder(limits, &renderedTotal)
		_, _ = fmt.Fprintf(output, "# Discord #%s - %s\n\n- Guild: %s\n- Channel: %s\n- UTC date: %s\n\n", safeAppText(channel.Name), key.day, safeAppText(identity.GuildName), safeAppText(channel.Name), key.day)
		for _, message := range grouped[key] {
			_, _ = fmt.Fprintf(output, "## Message %s\n\n- Time: %s\n- Author: %s\n- Author ID: %s\n", safeAppText(message.ID), message.Timestamp.UTC().Format(time.RFC3339), safeAppText(message.AuthorName), safeAppText(message.AuthorID))
			_, _ = fmt.Fprintf(output, "- Source: https://discord.com/channels/%s/%s/%s\n", url.PathEscape(identity.GuildID), url.PathEscape(message.ChannelID), url.PathEscape(message.ID))
			if message.AuthorBot {
				_, _ = output.WriteString("- Author type: bot\n")
			}
			if message.ThreadName != "" {
				_, _ = fmt.Fprintf(output, "- Thread: %s\n", safeAppText(message.ThreadName))
			}
			if !message.EditedTimestamp.IsZero() {
				_, _ = fmt.Fprintf(output, "- Edited: %s\n", message.EditedTimestamp.UTC().Format(time.RFC3339))
			}
			if strings.TrimSpace(message.Content) != "" {
				_, _ = fmt.Fprintf(output, "\n%s\n", safeAppText(message.Content))
			}
			for _, attachment := range message.Attachments {
				_, _ = fmt.Fprintf(output, "\n- Attachment: %s (%s)", safeAppText(attachment.Filename), safeAppText(attachment.URL))
			}
			_, _ = output.WriteString("\n\n")
		}
		content, err := output.Content()
		if err != nil {
			return nil, err
		}
		if !utf8.Valid(content) {
			return nil, errors.New("Discord document was not valid UTF-8")
		}
		documents = append(documents, AppDocument{RemoteID: "discord:guild:" + identity.GuildID + ":channel:" + key.channelID + ":" + key.day, Filename: "discord-" + safeAppIdentifier(key.channelID) + "-" + key.day + ".md", Markdown: content})
	}
	return documents, nil
}
