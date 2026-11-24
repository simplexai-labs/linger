package voice

import (
	"context"
	"errors"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/collaboration"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicelive"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

func (s *Service) addVoiceLiveRoomMembers(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall) (string, error) {
	var args struct {
		RoomID    string              `json:"room_id"`
		Members   []string            `json:"members"`
		ActorIDs  []string            `json:"actor_ids"`
		Confirmed voicelive.LooseBool `json:"confirmed"`
	}
	if voicelive.DecodeArguments(request.Arguments, &args) != nil || args.RoomID == "" ||
		len(args.ActorIDs)+len(args.Members) == 0 || len(args.ActorIDs)+len(args.Members) > voicelive.MaxRoomMembers || slices.Contains(args.ActorIDs, "") {
		return "", voicelive.ErrInvalid
	}
	account := textValue(session.AccountID)
	room, err := s.queries.GetRoomForAccount(ctx, store.GetRoomForAccountParams{ID: args.RoomID, AccountID: account})
	if errors.Is(err, pgx.ErrNoRows) || err == nil && (room.TenantID != session.TenantID || room.DeletionStartedAt.Valid) {
		return voicelive.ErrorOutput("room_unavailable"), nil
	}
	if err != nil {
		return "", err
	}
	if room.DirectAgentActorID.Valid || room.ParentRoomID.Valid {
		return voicelive.ErrorOutput("room_members_immutable"), nil
	}
	if len(args.Members) > 0 {
		matches, err := s.matchVoiceLiveRoomMembers(ctx, session, args.Members)
		if err != nil {
			return "", err
		}
		if matches.Problem != nil {
			return voicelive.Output(matches.Problem), nil
		}
		args.ActorIDs = append(args.ActorIDs, matches.IDs...)
	}
	if len(args.ActorIDs) == 0 {
		return "", voicelive.ErrInvalid
	}
	slices.Sort(args.ActorIDs)
	ids := slices.Compact(args.ActorIDs)
	names := make([]string, 0, len(ids))
	for _, id := range ids {
		actor, err := s.queries.GetActorForTenantAccount(ctx, store.GetActorForTenantAccountParams{ID: id, TenantID: session.TenantID, AccountID: account})
		if errors.Is(err, pgx.ErrNoRows) {
			return voicelive.ErrorOutput("member_unavailable"), nil
		}
		if err != nil {
			return "", err
		}
		names = append(names, actor.DisplayName)
	}
	prompt := voicelive.NeedsConfirmation("Will add " + strings.Join(names, ", ") + " to the room “" + room.Name + "”")
	// Names in the spoken preview can coincide. Bind approval to the exact room and Actors.
	key := prompt + "\x00" + room.ID + "\x00" + strings.Join(ids, "\x00")
	if confirmed, err := s.voiceLiveConfirmed(ctx, session, request, bool(args.Confirmed), key); err != nil || !confirmed {
		return prompt, err
	}
	result, err := s.collaboration.AddRoomMembers(ctx, session.AccountID, room.ID, ids, collaboration.AddedByAgent{ActorID: session.Agent.ID})
	switch {
	case errors.Is(err, collaboration.ErrDirectRoomImmutable), errors.Is(err, collaboration.ErrThreadImmutable):
		return voicelive.ErrorOutput("room_members_immutable"), nil
	case errors.Is(err, collaboration.ErrAgentNotRegistered), errors.Is(err, pgx.ErrNoRows):
		return voicelive.ErrorOutput("member_or_room_unavailable"), nil
	case errors.Is(err, collaboration.ErrAgentSponsorRequired):
		return voicelive.ErrorOutput("agent_sponsor_required"), nil
	case err != nil:
		return "", err
	}
	return voicelive.Output(map[string]any{"status": "updated", "room_id": room.ID, "room": room.Name, "added": result.Added, "already_members": result.AlreadyMembers}), nil
}

func (s *Service) matchVoiceLiveRoomMembers(ctx context.Context, session voicelive.Session, names []string) (voicelive.MemberMatch, error) {
	const pageSize = 500
	var directory []voicelive.DirectoryActor
	cursor := ""
	for {
		rows, err := s.queries.ListActorsForTenantAccount(ctx, store.ListActorsForTenantAccountParams{
			AccountID: session.AccountID, TenantID: session.TenantID, PageLimit: pageSize, Cursor: cursor,
		})
		if err != nil {
			return voicelive.MemberMatch{}, err
		}
		for _, row := range rows {
			directory = append(directory, voicelive.DirectoryActor{ID: row.ID, Name: row.DisplayName, Kind: row.Kind})
		}
		if len(rows) < pageSize {
			break
		}
		cursor = rows[len(rows)-1].ID
	}
	return voicelive.MatchMembers(names, directory, session.HumanActorID), nil
}
