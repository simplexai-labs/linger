package collaboration

import (
	"context"
	"net/http"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomcreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// ChannelRoomDisplayName maps a supported external channel identifier to its
// Room display name.
func ChannelRoomDisplayName(channel httpapi.RoomChannel) (string, bool) {
	switch channel {
	case httpapi.RoomChannelImessage:
		return "iMessage", true
	case httpapi.RoomChannelWechat:
		return "WeChat", true
	case httpapi.RoomChannelWhatsapp:
		return "WhatsApp", true
	case httpapi.RoomChannelTelegram:
		return "Telegram", true
	case httpapi.RoomChannelDiscord:
		return "Discord", true
	case httpapi.RoomChannelSlack:
		return "Slack", true
	default:
		return "", false
	}
}

// OpenAnotherMeChannel opens the Human's isolated Channel Room with their
// active Another Me for the given external channel, creating it on first use.
func (s *Service) OpenAnotherMeChannel(ctx context.Context, accountID, tenantID string, channel httpapi.RoomChannel) (DirectRoom, error) {
	displayName, ok := ChannelRoomDisplayName(channel)
	if !ok {
		return DirectRoom{}, roomcreation.ErrInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return DirectRoom{}, err
	}
	defer tx.Rollback(ctx)
	queries := s.queries.WithTx(tx)
	human, err := queries.GetHumanActor(ctx, store.GetHumanActorParams{
		TenantID: tenantID, AccountID: textValue(accountID),
	})
	if err != nil {
		return DirectRoom{}, err
	}
	registration, err := queries.GetAnotherMeRegistration(ctx, store.GetAnotherMeRegistrationParams{
		TenantID: tenantID, RepresentedHumanActorID: human.ID,
	})
	if err != nil {
		return DirectRoom{}, err
	}
	agent, err := queries.GetActor(ctx, store.GetActorParams{
		ID: registration.ActorID, TenantID: tenantID,
	})
	if err != nil {
		return DirectRoom{}, err
	}
	opened, err := roomcreation.OpenOrCreateChannelRoom(ctx, queries, roomcreation.ChannelSpec{
		TenantID: tenantID, Channel: string(channel), Human: human, Agent: agent, Name: displayName,
	})
	if err != nil {
		return DirectRoom{}, err
	}
	creator := human
	if !opened.Created {
		creator, err = queries.GetActor(ctx, store.GetActorParams{ID: opened.Room.CreatedByActorID, TenantID: tenantID})
		if err != nil {
			return DirectRoom{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return DirectRoom{}, err
	}
	status := http.StatusOK
	if opened.Created {
		status = http.StatusCreated
	}
	return DirectRoom{Status: status, Room: roomModel(opened.Room, creator)}, nil
}
