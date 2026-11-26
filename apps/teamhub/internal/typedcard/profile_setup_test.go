package typedcard

import (
	"strings"
	"testing"
)

func TestOnboardingStatusTextTellsAnotherMeWhatSetupCollected(t *testing.T) {
	t.Parallel()
	gmail := []OnboardingConnection{{ID: "connection_gmail", AppName: "Gmail", AccountLabel: "ada@example.test"}}
	for name, test := range map[string]struct {
		status onboardingStatus
		want   []string
	}{
		"open, nothing shared": {
			onboardingStatus{},
			[]string{"Setup cards: not finished", "Connected apps right now: none.", "mention once that they can still connect", "Do not open the personal-profile Skill"},
		},
		"open, app connected": {
			onboardingStatus{connections: gmail},
			[]string{"- Gmail ada@example.test, connection connection_gmail", "ask whether to start now from what is connected so far"},
		},
		"finished with sources after asking": {
			onboardingStatus{finished: true, links: []string{"https://ada.example"}, chatted: true, alreadyAsked: true},
			[]string{"Links: https://ada.example", "do not ask the Human about it again", "add these sources to it"},
		},
		"idle reminder": {
			onboardingStatus{connections: gmail, idleReminder: true},
			[]string{"Setup cards: not finished", "- Gmail ada@example.test, connection connection_gmail", "no message of theirs comes with this status", "ask whether to start now from what is connected"},
		},
		"finished, nothing shared": {
			onboardingStatus{finished: true, chatted: true},
			[]string{"Setup cards: finished.", "Links: none.", "Files: none.", "The Human shared nothing. Do not open the personal-profile Skill"},
		},
		"finished with sources after chatting": {
			onboardingStatus{finished: true, links: []string{"https://ada.example"}, chatted: true},
			[]string{"Links: https://ada.example", "ask the Human once whether to start now", "only offer to add the sources"},
		},
		"finished with sources, profile already started": {
			onboardingStatus{finished: true, connections: gmail, links: []string{"https://ada.example"}, profileStarted: true},
			[]string{"Links: https://ada.example", "Their profile is already started or done; do not start another initial build.", "Add any sources here that it does not cover yet with the personal-profile Skill"},
		},
		"finished with sources, quiet": {
			onboardingStatus{finished: true, connections: gmail, files: 2},
			[]string{"Files: 2, attached to this message.", "Tell the Human you are starting their profile"},
		},
	} {
		text := onboardingStatusText(test.status)
		if !strings.HasPrefix(text, "Onboarding status from TeamHub") {
			t.Fatalf("%s: text=%q", name, text)
		}
		// Apps can be granted after this status, so it never forbids checking them.
		if strings.Contains(text, "check apps") {
			t.Fatalf("%s: status forbids checking apps: %q", name, text)
		}
		for _, want := range test.want {
			if !strings.Contains(text, want) {
				t.Fatalf("%s: missing %q in %q", name, want, text)
			}
		}
		// Exactly one instruction closes the status.
		instructions := 0
		for _, line := range strings.Split(text, "\n") {
			if strings.Contains(line, "personal-profile Skill") {
				instructions++
			}
		}
		if instructions != 1 {
			t.Fatalf("%s: instructions=%d in %q", name, instructions, text)
		}
	}
}

func TestFinishedOnboardingStatusStartsProfileAfterIdleReminderWhileQuiet(t *testing.T) {
	t.Parallel()
	gmail := []OnboardingConnection{{ID: "connection_gmail", AppName: "Gmail", AccountLabel: "ada@example.test"}}
	links := []string{"https://ada.example"}
	for name, test := range map[string]struct {
		connections []OnboardingConnection
		links       []string
		files       int
		chatted     bool
		offered     bool
		notStarted  bool
		wantWrite   bool
		wantAsked   bool
		wantText    []string
		forbidText  []string
	}{
		"quiet after reminder, profile not started, sources skipped with gmail": {
			connections: gmail, offered: true, notStarted: true, wantWrite: true,
			wantText: []string{
				"Setup cards: finished.",
				"- Gmail ada@example.test, connection connection_gmail",
				"Tell the Human you are starting their profile from these sources",
			},
		},
		"quiet after reminder, profile not started, links added with gmail": {
			connections: gmail, links: links, offered: true, notStarted: true, wantWrite: true,
			wantText: []string{
				"Setup cards: finished.",
				"- Gmail ada@example.test, connection connection_gmail",
				"Links: https://ada.example",
				"Tell the Human you are starting their profile from these sources",
			},
		},
		"quiet after reminder, profile not started, nothing shared": {
			offered: true, notStarted: true, wantWrite: true,
			wantText: []string{
				"Setup cards: finished.",
				"The Human shared nothing. Do not open the personal-profile Skill",
			},
		},
		"quiet after reminder, profile already started, sources skipped": {
			connections: gmail, offered: true, notStarted: false, wantWrite: false,
		},
		"quiet after reminder, profile already started, links added": {
			connections: gmail, links: links, offered: true, notStarted: false, wantWrite: true, wantAsked: true,
			wantText: []string{
				"Setup cards: finished.",
				"Links: https://ada.example",
				"do not ask the Human about it again",
			},
			forbidText: []string{"Tell the Human you are starting their profile"},
		},
		"quiet without reminder, profile already started, sources skipped": {
			connections: gmail, offered: false, notStarted: false, wantWrite: true,
			wantText: []string{
				"Setup cards: finished.",
				"- Gmail ada@example.test, connection connection_gmail",
				"Their profile is already started or done; do not start another initial build.",
				"Add any sources here that it does not cover yet with the personal-profile Skill",
			},
			forbidText: []string{"Tell the Human you are starting their profile"},
		},
		"quiet without reminder, profile already started, sources with link": {
			connections: gmail, links: links, offered: false, notStarted: false, wantWrite: true,
			wantText: []string{
				"Setup cards: finished.",
				"- Gmail ada@example.test, connection connection_gmail",
				"Links: https://ada.example",
				"Their profile is already started or done; do not start another initial build.",
				"Add any sources here that it does not cover yet with the personal-profile Skill",
			},
			forbidText: []string{"Tell the Human you are starting their profile"},
		},
		"chatted and offered, sources skipped": {
			connections: gmail, chatted: true, offered: true, notStarted: true, wantWrite: false,
		},
		"chatted and offered, links added": {
			connections: gmail, links: links, chatted: true, offered: true, notStarted: true, wantWrite: true, wantAsked: true,
			wantText: []string{
				"Setup cards: finished.",
				"Links: https://ada.example",
				"do not ask the Human about it again",
			},
		},
		"chatted without offer, profile already started, links added": {
			connections: gmail, links: links, chatted: true, offered: false, notStarted: false, wantWrite: true,
			wantText: []string{
				"Setup cards: finished.",
				"Links: https://ada.example",
				"ask the Human once",
				"only offer to add",
			},
			forbidText: []string{
				"Tell the Human you are starting their profile",
				"Add any sources here that it does not cover yet",
			},
		},
		"chatted without offer, sources skipped with gmail": {
			connections: gmail, chatted: true, offered: false, notStarted: true, wantWrite: true,
			wantText: []string{
				"Setup cards: finished.",
				"- Gmail ada@example.test, connection connection_gmail",
				"ask the Human once whether to start now",
			},
		},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			status, ok := finishedOnboardingStatus(test.links, test.files, test.chatted, test.offered, test.notStarted)
			if ok != test.wantWrite {
				t.Fatalf("write=%v want %v (status=%+v)", ok, test.wantWrite, status)
			}
			if !ok {
				return
			}
			if !status.finished || status.chatted != test.chatted || status.alreadyAsked != test.wantAsked || status.profileStarted != !test.notStarted {
				t.Fatalf("status=%+v want finished=true chatted=%v alreadyAsked=%v profileStarted=%v", status, test.chatted, test.wantAsked, !test.notStarted)
			}
			status.connections = test.connections
			text := onboardingStatusText(status)
			for _, want := range test.wantText {
				if !strings.Contains(text, want) {
					t.Fatalf("missing %q in %q", want, text)
				}
			}
			for _, forbid := range test.forbidText {
				if strings.Contains(text, forbid) {
					t.Fatalf("unexpected %q in %q", forbid, text)
				}
			}
		})
	}
}
