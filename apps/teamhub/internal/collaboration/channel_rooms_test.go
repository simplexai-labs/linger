package collaboration

import (
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func TestChannelRoomDisplayName(t *testing.T) {
	cases := []struct {
		channel httpapi.RoomChannel
		want    string
	}{
		{httpapi.RoomChannelImessage, "iMessage"},
		{httpapi.RoomChannelWechat, "WeChat"},
		{httpapi.RoomChannelWhatsapp, "WhatsApp"},
		{httpapi.RoomChannelTelegram, "Telegram"},
		{httpapi.RoomChannelDiscord, "Discord"},
		{httpapi.RoomChannelSlack, "Slack"},
	}
	for _, tc := range cases {
		name, ok := ChannelRoomDisplayName(tc.channel)
		if !ok || name != tc.want {
			t.Fatalf("ChannelRoomDisplayName(%q) = (%q, %v), want (%q, true)", tc.channel, name, ok, tc.want)
		}
	}
	if _, ok := ChannelRoomDisplayName(httpapi.RoomChannel("unknown")); ok {
		t.Fatal("ChannelRoomDisplayName(unknown) = true, want false")
	}
}

func TestChannelRoomModelsExposeChannel(t *testing.T) {
	now := pgtype.Timestamptz{Time: time.Unix(1_700_000_000, 0).UTC(), Valid: true}
	creator := store.Actor{ID: "actor_h", TenantID: "tenant_1", Kind: "human", DisplayName: "Owner", CreatedAt: now}

	room := roomModel(store.Room{
		ID: "room_im", TenantID: "tenant_1", Name: "iMessage",
		CreatedByActorID: creator.ID, CreatedAt: now, UpdatedAt: now,
		ChannelKind: pgtype.Text{String: "imessage", Valid: true},
	}, creator)
	if room.Kind != httpapi.RoomKindRoom {
		t.Fatalf("room.Kind = %q, want room", room.Kind)
	}
	if room.Channel == nil || *room.Channel != httpapi.RoomChannelImessage {
		t.Fatalf("room.Channel = %v, want imessage", room.Channel)
	}

	listed := roomListItemModel(store.ListRoomsForTenantAccountRow{
		ID: "room_im", TenantID: "tenant_1", Name: "iMessage",
		CreatedByActorID: creator.ID, NextRoomSeq: 1,
		CreatedAt: now, UpdatedAt: now, ChannelKind: "imessage",
	}, creator)
	if listed.Channel == nil || *listed.Channel != httpapi.RoomChannelImessage {
		t.Fatalf("listed.Channel = %v, want imessage", listed.Channel)
	}

	hit := messageSearchRoomModel(store.SearchTenantMessagesForAccountRow{
		RoomID: "room_im", RoomName: "iMessage", ChannelKind: "imessage",
	})
	if hit.Channel == nil || *hit.Channel != httpapi.RoomChannelImessage {
		t.Fatalf("hit.Channel = %v, want imessage", hit.Channel)
	}
}
