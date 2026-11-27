package agentruntimestate

import (
	"encoding/json"
	"testing"
)

func TestRunTokenCountsPreserveReasoningSubset(t *testing.T) {
	zero, reasoning, tooMuch := int64(0), int64(10), int64(21)
	for _, test := range []struct {
		name   string
		counts RunTokenCounts
		valid  bool
	}{
		{"unknown reasoning", RunTokenCounts{Input: 10, CacheRead: 30, Output: 20}, true},
		{"known zero reasoning", RunTokenCounts{Output: 20, Reasoning: &zero}, true},
		{"reasoning within output", RunTokenCounts{Output: 20, Reasoning: &reasoning}, true},
		{"reasoning exceeds output", RunTokenCounts{Output: 20, Reasoning: &tooMuch}, false},
		{"negative cache", RunTokenCounts{CacheRead: -1}, false},
		{"unsafe JSON integer", RunTokenCounts{Input: 9007199254740992}, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if validTokenCounts(test.counts) != test.valid {
				t.Fatalf("valid=%v want %v", validTokenCounts(test.counts), test.valid)
			}
		})
	}
}

func TestFilterLocalRunUsageSkipsInvalidEntriesWithoutRejectingReceipt(t *testing.T) {
	valid := `{"provider":"anthropic","model":"claude-sonnet","input":10,"cache_read":0,"cache_write":0,"output":5}`
	synthetic := `{"provider":"anthropic","model":"<synthetic>","input":0,"cache_read":0,"cache_write":0,"output":0}`
	reasoningTooLarge := `{"provider":"anthropic","model":"claude-haiku","input":1,"cache_read":0,"cache_write":0,"output":2,"reasoning":3}`
	t.Run("synthetic entry is skipped and valid entry kept", func(t *testing.T) {
		usages, rejected := filterLocalRunUsage(json.RawMessage("["+synthetic+","+valid+"]"), "claude")
		if len(usages) != 1 || usages[0].Model != "claude-sonnet" {
			t.Fatalf("usages=%+v", usages)
		}
		if len(rejected) != 1 || rejected[0].reason != "invalid_entry" || rejected[0].model != "<synthetic>" {
			t.Fatalf("rejected=%+v", rejected)
		}
	})
	t.Run("reasoning above output skips only that entry", func(t *testing.T) {
		usages, rejected := filterLocalRunUsage(json.RawMessage("["+reasoningTooLarge+","+valid+"]"), "claude")
		if len(usages) != 1 || usages[0].Model != "claude-sonnet" || len(rejected) != 1 || rejected[0].model != "claude-haiku" {
			t.Fatalf("usages=%+v rejected=%+v", usages, rejected)
		}
	})
	t.Run("duplicate models skip the whole receipt usage", func(t *testing.T) {
		usages, rejected := filterLocalRunUsage(json.RawMessage("["+valid+","+valid+"]"), "claude")
		if usages != nil || len(rejected) != 1 || rejected[0].reason != "malformed" {
			t.Fatalf("usages=%+v rejected=%+v", usages, rejected)
		}
	})
	t.Run("malformed JSON skips the whole receipt usage", func(t *testing.T) {
		usages, rejected := filterLocalRunUsage(json.RawMessage(`[{"model":`), "claude")
		if usages != nil || len(rejected) != 1 || rejected[0].reason != "malformed" {
			t.Fatalf("usages=%+v rejected=%+v", usages, rejected)
		}
	})
	t.Run("unknown fields are malformed", func(t *testing.T) {
		usages, _ := filterLocalRunUsage(json.RawMessage(`[{"model":"m","unexpected":1}]`), "claude")
		if usages != nil {
			t.Fatalf("usages=%+v", usages)
		}
	})
}

func TestFilterLocalRunUsageAcceptsAntigravityAndLegacyUnknownProvider(t *testing.T) {
	t.Run("accepts antigravity provider with reasoning and compactions", func(t *testing.T) {
		raw := json.RawMessage(`[{"provider":"antigravity","model":"gemini-pro","input":100,"cache_read":25,"cache_write":0,"output":40,"reasoning":15,"compaction_count":2}]`)
		usages, rejected := filterLocalRunUsage(raw, "antigravity")
		if len(rejected) != 0 || len(usages) != 1 {
			t.Fatalf("usages=%+v rejected=%+v", usages, rejected)
		}
		if usages[0].Provider != "antigravity" || usages[0].Reasoning == nil || *usages[0].Reasoning != 15 || usages[0].CompactionCount == nil || *usages[0].CompactionCount != 2 {
			t.Fatalf("usage=%+v", usages[0])
		}
	})

	t.Run("accepts unknown provider from older Daemons", func(t *testing.T) {
		raw := json.RawMessage(`[{"provider":"unknown","model":"gemini-pro","input":10,"cache_read":0,"cache_write":0,"output":5,"reasoning":2,"compaction_count":0}]`)
		usages, rejected := filterLocalRunUsage(raw, "antigravity")
		if len(rejected) != 0 || len(usages) != 1 || usages[0].Provider != "unknown" {
			t.Fatalf("usages=%+v rejected=%+v", usages, rejected)
		}
	})

	t.Run("rejects openai and anthropic providers for antigravity", func(t *testing.T) {
		raw := json.RawMessage(`[
			{"provider":"openai","model":"gemini-a","input":10,"cache_read":0,"cache_write":0,"output":5},
			{"provider":"anthropic","model":"gemini-b","input":10,"cache_read":0,"cache_write":0,"output":5}
		]`)
		usages, rejected := filterLocalRunUsage(raw, "antigravity")
		if len(usages) != 0 || len(rejected) != 2 {
			t.Fatalf("usages=%+v rejected=%+v", usages, rejected)
		}
	})
}
