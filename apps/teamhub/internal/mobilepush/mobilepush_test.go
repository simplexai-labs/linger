package mobilepush

import (
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func TestClassify(t *testing.T) {
	const human = "actor_human"
	reply := store.GetMobilePushMessageRow{
		RoomSeq: 10, MessageKind: "conversation", FromAgent: true,
		FromDirectAgent: true, DirectHumanActorID: human,
	}
	phone := store.ListPushTargetsForRoomRow{HumanActorID: human, PushReplies: true, PushDecisions: true, ReadThroughRoomSeq: 9}
	with := func(change func(*store.GetMobilePushMessageRow)) store.GetMobilePushMessageRow {
		facts := reply
		change(&facts)
		return facts
	}
	cases := []struct {
		name   string
		facts  store.GetMobilePushMessageRow
		target store.ListPushTargetsForRoomRow
		want   string
	}{
		{"a direct Agent's reply", reply, phone, KindMessage},
		{"already read", reply, store.ListPushTargetsForRoomRow{HumanActorID: human, PushReplies: true, ReadThroughRoomSeq: 10}, ""},
		{"replies turned off", reply, store.ListPushTargetsForRoomRow{HumanActorID: human, PushDecisions: true}, ""},
		{"another Human's direct chat", with(func(f *store.GetMobilePushMessageRow) { f.DirectHumanActorID = "actor_other" }), phone, ""},
		{"a group message that mentions the Human", with(func(f *store.GetMobilePushMessageRow) {
			f.FromDirectAgent, f.DirectHumanActorID, f.MentionedActorIds = false, "", []string{human}
		}), phone, KindMessage},
		{"a group message that does not", with(func(f *store.GetMobilePushMessageRow) {
			f.FromDirectAgent, f.DirectHumanActorID = false, ""
		}), phone, ""},
		{"the Human's own message", with(func(f *store.GetMobilePushMessageRow) { f.FromAgent = false }), phone, ""},
		{"a runtime message", with(func(f *store.GetMobilePushMessageRow) { f.MessageKind = "agent_runtime" }), phone, ""},
		{"a decision", with(func(f *store.GetMobilePushMessageRow) { f.AsksDecision = true }), phone, KindDecision},
		{"a decision, read or not", with(func(f *store.GetMobilePushMessageRow) { f.AsksDecision = true }), store.ListPushTargetsForRoomRow{HumanActorID: human, PushDecisions: true, ReadThroughRoomSeq: 99}, KindDecision},
		{"decisions turned off", with(func(f *store.GetMobilePushMessageRow) { f.AsksDecision = true }), store.ListPushTargetsForRoomRow{HumanActorID: human, PushReplies: true}, ""},
	}
	for _, c := range cases {
		if got := Classify(c.facts, c.target); got != c.want {
			t.Errorf("%s: Classify = %q, want %q", c.name, got, c.want)
		}
	}
}
