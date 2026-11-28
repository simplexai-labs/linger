package agentconnectedapps

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/externalsource"
)

// discordScope says what each Discord read names: nothing beyond the
// connected server, a server by guild_id, or a channel or thread by
// channel_id. The managed Discord bot is one application shared by every
// connection, so the provider alone does not keep a read inside the server
// this connection was installed in.
type discordScope int

const (
	discordConnectedGuild discordScope = iota + 1
	discordGuildArgument
	discordChannelArgument
)

var discordReadScopes = map[string]discordScope{
	"DISCORDBOT_GET_CONNECTED_GUILD":          discordConnectedGuild,
	"DISCORDBOT_GET_GUILD":                    discordGuildArgument,
	"DISCORDBOT_LIST_GUILD_CHANNELS":          discordGuildArgument,
	"DISCORDBOT_GET_ACTIVE_GUILD_THREADS":     discordGuildArgument,
	"DISCORDBOT_GET_CHANNEL":                  discordChannelArgument,
	"DISCORDBOT_LIST_PUBLIC_ARCHIVED_THREADS": discordChannelArgument,
	"DISCORDBOT_LIST_MESSAGES":                discordChannelArgument,
	"DISCORDBOT_GET_MESSAGE":                  discordChannelArgument,
	"DISCORDBOT_LIST_PINNED_MESSAGES":         discordChannelArgument,
}

// discordReadInScope reports whether a read may run at once. Every read
// outside Discord may. A Discord read may only when it provably stays in the
// connection's server (RemoteTeamID); anything TeamHub cannot prove, including
// a lookup the provider refused, is held for the sponsor like a write. A
// lookup that failed transiently returns its error, so the read neither runs
// nor waits on a card.
func (s *Service) discordReadInScope(ctx context.Context, connection externalsource.AgentToolConnection, slug string, arguments map[string]any) (bool, error) {
	scope, discord := discordReadScopes[slug]
	if !discord {
		if connection.AppKey == "discord" || strings.HasPrefix(slug, "DISCORDBOT_") {
			return false, nil
		}
		return true, nil
	}
	switch scope {
	case discordConnectedGuild:
		return true, nil
	case discordGuildArgument:
		guildID, _ := arguments["guild_id"].(string)
		return connection.RemoteTeamID != "" && guildID == connection.RemoteTeamID, nil
	case discordChannelArgument:
		channelID, _ := arguments["channel_id"].(string)
		if channelID == "" || connection.RemoteTeamID == "" {
			return false, nil
		}
		guildID, err := s.provider.GetDiscordChannelGuild(ctx, connection.UpstreamConnectionID, channelID)
		if err != nil {
			if errors.Is(err, composio.ErrDiscordToolRefused) || errors.Is(err, composio.ErrDiscordChannelGuildUnknown) || refusedLookup(err) {
				return false, nil
			}
			return false, mapToolError(&providerOperationError{phase: "discord_channel_lookup", err: err}, "execute")
		}
		return guildID == connection.RemoteTeamID, nil
	default:
		return false, nil
	}
}

// refusedLookup reports a client error that retrying will not change, such
// as a channel the bot cannot see; timeouts and rate limits are transient.
func refusedLookup(err error) bool {
	status, ok := composio.ErrorStatus(err)
	return ok && status >= 400 && status < 500 &&
		status != http.StatusRequestTimeout && status != http.StatusTooManyRequests
}
