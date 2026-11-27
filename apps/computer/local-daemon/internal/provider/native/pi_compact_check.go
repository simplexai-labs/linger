package native

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"os"
	"path/filepath"
	"strings"
)

const (
	// piDefaultKeepRecentTokens matches Pi's built-in compaction.keepRecentTokens.
	piDefaultKeepRecentTokens = 20000
	// piEstimatedImageChars matches Pi's ESTIMATED_IMAGE_CHARS heuristic (~1200 tokens).
	piEstimatedImageChars = 4800
	// piMaxSafeJSInt is Number.MAX_SAFE_INTEGER in JavaScript.
	piMaxSafeJSInt = 9007199254740991
)

// piEnvValue reads name from a KEY=VALUE slice, preferring an exact key match
// and falling back to a case-insensitive match for Windows environments.
func piEnvValue(env []string, name string) string {
	var fallback string
	for _, entry := range env {
		key, value, ok := strings.Cut(entry, "=")
		if !ok {
			continue
		}
		if key == name {
			return value
		}
		if strings.EqualFold(key, name) {
			fallback = value
		}
	}
	return fallback
}

// piAgentDirFromEnv resolves Pi's global configuration directory from the
// child process environment, matching Pi's PI_CODING_AGENT_DIR and ~/.pi/agent
// lookup rules.
func piAgentDirFromEnv(env []string) string {
	home := piEnvValue(env, "HOME")
	if home == "" {
		home = piEnvValue(env, "USERPROFILE")
	}
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	if dir := strings.TrimSpace(piEnvValue(env, "PI_CODING_AGENT_DIR")); dir != "" {
		if dir == "~" {
			return home
		}
		if strings.HasPrefix(dir, "~/") || strings.HasPrefix(dir, `~\`) {
			if home != "" {
				return filepath.Join(home, dir[2:])
			}
			return dir
		}
		return dir
	}
	if home == "" {
		return ""
	}
	return filepath.Join(home, ".pi", "agent")
}

type piCompactionSettings struct {
	keepRecentTokens *int
	modelOverrides   map[string]int
}

// piLoadCompactionSettings snapshots Pi's global compaction settings from
// <agentDir>/settings.json once at process launch, matching Pi's startup load.
// Managed Pi always starts with --no-approve (PiRPCResourceArgs), so Pi runs
// with projectTrusted=false and ignores project <cwd>/.pi/settings.json.
func piLoadCompactionSettings(agentDir string) piCompactionSettings {
	if agentDir == "" {
		return piCompactionSettings{}
	}
	return piReadCompactionSettings(filepath.Join(agentDir, "settings.json"))
}

// piResolveKeepRecentTokens computes Pi's effective compaction.keepRecentTokens
// from snapshotted startup settings, applying modelOverrides[modelID] ->
// compaction.keepRecentTokens -> default 20000.
func piResolveKeepRecentTokens(settings piCompactionSettings, modelID string) int {
	if modelID != "" {
		if value, ok := settings.modelOverrides[modelID]; ok {
			return value
		}
	}
	if settings.keepRecentTokens != nil {
		return *settings.keepRecentTokens
	}
	return piDefaultKeepRecentTokens
}

func piReadCompactionSettings(path string) piCompactionSettings {
	data, err := os.ReadFile(path)
	if err != nil {
		return piCompactionSettings{}
	}
	data = bytes.TrimPrefix(data, []byte{0xEF, 0xBB, 0xBF})
	var root map[string]json.RawMessage
	if err := json.Unmarshal(data, &root); err != nil {
		return piCompactionSettings{}
	}
	rawCompaction, ok := root["compaction"]
	if !ok {
		return piCompactionSettings{}
	}
	var compaction map[string]json.RawMessage
	if err := json.Unmarshal(rawCompaction, &compaction); err != nil || compaction == nil {
		return piCompactionSettings{}
	}
	var result piCompactionSettings
	if rawKeep, ok := compaction["keepRecentTokens"]; ok {
		if value, valid := piParseNonNegativeInt(rawKeep); valid {
			result.keepRecentTokens = &value
		}
	}
	if rawOverrides, ok := compaction["modelOverrides"]; ok {
		var overrides map[string]json.RawMessage
		if err := json.Unmarshal(rawOverrides, &overrides); err == nil && overrides != nil {
			result.modelOverrides = make(map[string]int, len(overrides))
			for modelKey, rawEntry := range overrides {
				var entry map[string]json.RawMessage
				if err := json.Unmarshal(rawEntry, &entry); err != nil || entry == nil {
					continue
				}
				if rawKeep, ok := entry["keepRecentTokens"]; ok {
					if value, valid := piParseNonNegativeInt(rawKeep); valid {
						result.modelOverrides[modelKey] = value
					}
				}
			}
		}
	}
	return result
}

func piParseNonNegativeInt(raw json.RawMessage) (int, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return 0, false
	}
	switch trimmed[0] {
	case '"', '{', '[', 'n', 't', 'f':
		return 0, false
	}
	var value float64
	if err := json.Unmarshal(trimmed, &value); err != nil {
		return 0, false
	}
	if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || math.Trunc(value) != value || value > piMaxSafeJSInt || value > float64(math.MaxInt) {
		return 0, false
	}
	return int(value), true
}

type piSessionEntry struct {
	Type             string          `json:"type"`
	ID               string          `json:"id"`
	ParentID         string          `json:"parentId"`
	Message          *piContextMsg   `json:"message"`
	Content          json.RawMessage `json:"content"`
	Summary          string          `json:"summary"`
	FirstKeptEntryID string          `json:"firstKeptEntryId"`
	SystemMessage    *piContextMsg   `json:"systemMessage"`
	TargetID         string          `json:"targetId"`
	Replacement      json.RawMessage `json:"replacement"`
}

type piContextMsg struct {
	Role       string            `json:"role"`
	Content    json.RawMessage   `json:"content"`
	Sections   map[string]string `json:"sections"`
	ToolsAdded json.RawMessage   `json:"toolsAdded"`
	Command    string            `json:"command"`
	Output     string            `json:"output"`
	Summary    string            `json:"summary"`
}

type piContentBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	Thinking  string          `json:"thinking"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

type piProjectedEntry struct {
	source   piSessionEntry
	messages []piContextMsg
}

// piSessionCanCompact structurally evaluates whether Pi's prepareCompaction
// will accept the active branch of sessionFile under keepRecentTokens. It
// mirrors @earendil-works/pi-coding-agent@1.5.2's prepareCompaction,
// buildSessionProjection, and getCompactionTokenSetting (revisit when bumping
// the pinned Pi version) so uncompactable sessions return nothing_to_compact
// without matching Pi error prose.
func piSessionCanCompact(sessionFile string, keepRecentTokens int) (bool, error) {
	entries, err := piReadSessionEntries(sessionFile)
	if err != nil {
		return false, err
	}
	if len(entries) == 0 {
		return false, nil
	}
	path := piBuildSessionPath(entries)
	if len(path) == 0 || path[len(path)-1].Type == "compaction" {
		return false, nil
	}
	projected := piBuildSessionProjection(path)
	boundaryStart := 0
	for i, entry := range projected {
		if entry.source.Type == "compaction" && len(entry.messages) > 0 {
			boundaryStart = i + 1
			break
		}
	}
	boundaryEnd := len(projected)
	cutIndex, turnStartIndex, isSplitTurn, ok := piFindProjectedCutPoint(projected, boundaryStart, boundaryEnd, keepRecentTokens)
	if !ok || cutIndex < boundaryStart || cutIndex >= boundaryEnd || projected[cutIndex].source.ID == "" {
		return false, nil
	}
	historyEnd := cutIndex
	if isSplitTurn {
		historyEnd = turnStartIndex
	}
	if piHasCompactableMessages(projected[boundaryStart:historyEnd]) {
		return true, nil
	}
	if isSplitTurn && piHasCompactableMessages(projected[turnStartIndex:cutIndex]) {
		return true, nil
	}
	return false, nil
}

// piReadSessionEntries streams non-header JSONL entries from sessionFile using
// ReadBytes so arbitrarily long lines never hit a fixed scanner token limit.
func piReadSessionEntries(sessionFile string) ([]piSessionEntry, error) {
	file, err := os.Open(sessionFile)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	reader := bufio.NewReaderSize(file, 64<<10)
	var entries []piSessionEntry
	for {
		line, err := reader.ReadBytes('\n')
		if trimmed := bytes.TrimSpace(line); len(trimmed) > 0 {
			var entry piSessionEntry
			if json.Unmarshal(trimmed, &entry) == nil && entry.Type != "" && entry.Type != "session" {
				if entry.Type == "message" && entry.Message != nil && entry.Message.Role == "hookMessage" {
					entry.Message.Role = "custom"
				}
				entries = append(entries, entry)
			}
		}
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}
	}
	return entries, nil
}

// piBuildSessionPath walks parentId pointers from the last entry to root.
// Real Pi requires entry IDs for cut points, so an ID-less leaf produces no
// compactable path.
func piBuildSessionPath(entries []piSessionEntry) []piSessionEntry {
	if len(entries) == 0 {
		return nil
	}
	leaf := entries[len(entries)-1]
	if leaf.ID == "" {
		return nil
	}
	index := make(map[string]int, len(entries))
	for i, entry := range entries {
		if entry.ID != "" {
			index[entry.ID] = i
		}
	}
	path := make([]piSessionEntry, 0, len(entries))
	visited := make(map[string]struct{}, len(entries))
	current := leaf
	for {
		if current.ID != "" {
			if _, seen := visited[current.ID]; seen {
				break
			}
			visited[current.ID] = struct{}{}
		}
		path = append(path, current)
		if current.ParentID == "" {
			break
		}
		parentIdx, ok := index[current.ParentID]
		if !ok {
			break
		}
		current = entries[parentIdx]
	}
	for i, j := 0, len(path)-1; i < j; i, j = i+1, j-1 {
		path[i], path[j] = path[j], path[i]
	}
	return path
}

func piBuildContextEntries(path []piSessionEntry) []piSessionEntry {
	compactionIdx := -1
	for i, entry := range path {
		if entry.Type == "compaction" {
			compactionIdx = i
		}
	}
	if compactionIdx < 0 {
		return path
	}
	compaction := path[compactionIdx]
	contextEntries := make([]piSessionEntry, 0, len(path)-compactionIdx+1)
	contextEntries = append(contextEntries, compaction)
	foundFirstKept := false
	for i := 0; i < compactionIdx; i++ {
		entry := path[i]
		if compaction.FirstKeptEntryID != "" && entry.ID == compaction.FirstKeptEntryID {
			foundFirstKept = true
		}
		if foundFirstKept && !(entry.Type == "message" && entry.Message != nil && entry.Message.Role == "system") {
			contextEntries = append(contextEntries, entry)
		}
	}
	contextEntries = append(contextEntries, path[compactionIdx+1:]...)
	return contextEntries
}

func piBuildSessionProjection(path []piSessionEntry) []piProjectedEntry {
	contextEntries := piBuildContextEntries(path)
	edits := make(map[string]piSessionEntry)
	for _, entry := range contextEntries {
		if entry.Type == "context_edit" && entry.TargetID != "" {
			edits[entry.TargetID] = entry
		}
	}
	projected := make([]piProjectedEntry, len(contextEntries))
	for i, source := range contextEntries {
		var messages []piContextMsg
		if source.Type == "compaction" && i > 0 {
			messages = nil
		} else {
			var edit *piSessionEntry
			if source.ID != "" {
				if found, ok := edits[source.ID]; ok {
					edit = &found
				}
			}
			messages = piProjectContextEntry(source, edit)
		}
		projected[i] = piProjectedEntry{source: source, messages: messages}
	}
	return projected
}

func piProjectContextEntry(entry piSessionEntry, edit *piSessionEntry) []piContextMsg {
	messages := piEntryToContextMessages(entry)
	if edit == nil {
		return messages
	}
	trimmed := bytes.TrimSpace(edit.Replacement)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil
	}
	var replacement struct {
		Content json.RawMessage `json:"content"`
	}
	if err := json.Unmarshal(trimmed, &replacement); err != nil {
		return messages
	}
	out := make([]piContextMsg, len(messages))
	for i, msg := range messages {
		switch msg.Role {
		case "user", "assistant", "toolResult", "custom":
			content := replacement.Content
			if (msg.Role == "assistant" || msg.Role == "toolResult") && piIsJSONString(content) {
				var text string
				if json.Unmarshal(content, &text) == nil {
					wrapped, _ := json.Marshal([]piContentBlock{{Type: "text", Text: text}})
					content = wrapped
				}
			}
			msg.Content = content
		}
		out[i] = msg
	}
	return out
}

func piEntryToContextMessages(entry piSessionEntry) []piContextMsg {
	switch entry.Type {
	case "message":
		if entry.Message == nil {
			return nil
		}
		msg := *entry.Message
		if msg.Role == "system" && piIsEmptyOrNullJSON(msg.Content) {
			msg.Content = json.RawMessage(`""`)
		} else if (msg.Role == "user" || msg.Role == "assistant" || msg.Role == "toolResult") && piIsEmptyOrNullJSON(msg.Content) {
			msg.Content = json.RawMessage(`[]`)
		}
		return []piContextMsg{msg}
	case "custom_message":
		content := entry.Content
		if piIsEmptyOrNullJSON(content) {
			content = json.RawMessage(`[]`)
		}
		return []piContextMsg{{Role: "custom", Content: content}}
	case "branch_summary":
		if entry.Summary == "" {
			return nil
		}
		return []piContextMsg{{Role: "branchSummary", Summary: entry.Summary}}
	case "compaction":
		summary := piContextMsg{Role: "compactionSummary", Summary: entry.Summary}
		if entry.SystemMessage != nil {
			return []piContextMsg{*entry.SystemMessage, summary}
		}
		return []piContextMsg{summary}
	default:
		return nil
	}
}

func piFindProjectedCutPoint(entries []piProjectedEntry, startIndex, endIndex, keepRecentTokens int) (cutIndex, turnStartIndex int, isSplitTurn, ok bool) {
	var cutPoints []int
	for i := startIndex; i < endIndex; i++ {
		if entries[i].source.Type != "compaction" && piAnyCutPointMessage(entries[i].messages) {
			cutPoints = append(cutPoints, i)
		}
	}
	if len(cutPoints) == 0 {
		return startIndex, -1, false, false
	}
	accumulatedTokens := 0
	exceededBudget := false
	cutIndex = cutPoints[0]
	for i := endIndex - 1; i >= startIndex; i-- {
		messageTokens := 0
		for _, msg := range entries[i].messages {
			messageTokens += piEstimateTokens(msg)
		}
		if messageTokens == 0 {
			continue
		}
		accumulatedTokens += messageTokens
		if accumulatedTokens >= keepRecentTokens {
			exceededBudget = true
			cutIndex = cutPoints[len(cutPoints)-1]
			for _, candidate := range cutPoints {
				if candidate >= i {
					cutIndex = candidate
					break
				}
			}
			break
		}
	}
	if exceededBudget && piIsRecoveryOmissionSuffix(entries[cutIndex+1:endIndex]) {
		cutIndex++
	}
	for cutIndex > startIndex {
		prev := entries[cutIndex-1]
		if prev.source.Type == "compaction" || len(prev.messages) > 0 {
			break
		}
		cutIndex--
	}
	if cutIndex >= endIndex {
		return cutIndex, -1, false, false
	}
	startsTurn := piIsProjectedTurnStart(entries[cutIndex])
	turnStartIndex = -1
	if !startsTurn {
		for i := cutIndex; i >= startIndex; i-- {
			if piIsProjectedTurnStart(entries[i]) {
				turnStartIndex = i
				break
			}
		}
	}
	return cutIndex, turnStartIndex, !startsTurn && turnStartIndex != -1, true
}

func piIsRecoveryOmissionSuffix(suffix []piProjectedEntry) bool {
	if len(suffix) == 0 {
		return false
	}
	isIntrinsicallyVisible := func(entry piProjectedEntry) bool {
		return entry.source.Type != "context_edit" && len(piEntryToContextMessages(entry.source)) > 0
	}
	omittedIDs := make(map[string]struct{})
	hasOmittedAssistant := false
	for _, entry := range suffix {
		if entry.source.Type == "compaction" {
			return false
		}
		visible := isIntrinsicallyVisible(entry)
		omitted := visible && len(entry.messages) == 0
		if visible && !omitted {
			return false
		}
		if omitted {
			if entry.source.ID != "" {
				omittedIDs[entry.source.ID] = struct{}{}
			}
			if entry.source.Type == "message" && entry.source.Message != nil && entry.source.Message.Role == "assistant" {
				hasOmittedAssistant = true
			}
		}
	}
	if !hasOmittedAssistant {
		return false
	}
	for _, entry := range suffix {
		if entry.source.Type == "context_edit" && !piIsEmptyOrNullJSON(entry.source.Replacement) {
			if _, ok := omittedIDs[entry.source.TargetID]; !ok {
				return false
			}
		}
	}
	return true
}

func piAnyCutPointMessage(messages []piContextMsg) bool {
	for _, msg := range messages {
		switch msg.Role {
		case "user", "assistant", "bashExecution", "custom", "branchSummary", "compactionSummary":
			return true
		}
	}
	return false
}

func piIsProjectedTurnStart(entry piProjectedEntry) bool {
	if entry.source.Type == "compaction" {
		return false
	}
	for _, msg := range entry.messages {
		switch msg.Role {
		case "user", "bashExecution", "custom", "branchSummary", "compactionSummary":
			return true
		}
	}
	return false
}

func piHasCompactableMessages(entries []piProjectedEntry) bool {
	for _, entry := range entries {
		if entry.source.Type == "compaction" {
			continue
		}
		for _, msg := range entry.messages {
			if msg.Role != "system" {
				return true
			}
		}
	}
	return false
}

func piEstimateTokens(msg piContextMsg) int {
	chars := 0
	switch msg.Role {
	case "system":
		chars = piEstimateTextAndImageChars(msg.Content)
		for _, section := range msg.Sections {
			chars += piUTF16Len(section)
		}
		if piIsTruthyJSON(msg.ToolsAdded) {
			chars += piCompactJSONUTF16Len(msg.ToolsAdded)
		}
	case "user", "custom", "toolResult":
		chars = piEstimateTextAndImageChars(msg.Content)
	case "assistant":
		var blocks []piContentBlock
		if json.Unmarshal(msg.Content, &blocks) == nil {
			for _, block := range blocks {
				switch block.Type {
				case "text":
					chars += piUTF16Len(block.Text)
				case "thinking":
					chars += piUTF16Len(block.Thinking)
				case "toolCall":
					chars += piUTF16Len(block.Name) + piCompactJSONUTF16Len(block.Arguments)
				}
			}
		}
	case "bashExecution":
		chars = piUTF16Len(msg.Command) + piUTF16Len(msg.Output)
	case "branchSummary", "compactionSummary":
		chars = piUTF16Len(msg.Summary)
	default:
		return 0
	}
	return piCeilDiv4(chars)
}

func piEstimateTextAndImageChars(content json.RawMessage) int {
	trimmed := bytes.TrimSpace(content)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return 0
	}
	if trimmed[0] == '"' {
		var text string
		if json.Unmarshal(trimmed, &text) == nil {
			return piUTF16Len(text)
		}
		return 0
	}
	if trimmed[0] == '[' {
		var blocks []piContentBlock
		if json.Unmarshal(trimmed, &blocks) == nil {
			chars := 0
			for _, block := range blocks {
				switch block.Type {
				case "text":
					chars += piUTF16Len(block.Text)
				case "image":
					chars += piEstimatedImageChars
				}
			}
			return chars
		}
	}
	return 0
}

func piUTF16Len(s string) int {
	n := 0
	for _, r := range s {
		if r > 0xFFFF {
			n += 2
		} else {
			n++
		}
	}
	return n
}

func piCompactJSONUTF16Len(raw json.RawMessage) int {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return 0
	}
	var buf bytes.Buffer
	if err := json.Compact(&buf, trimmed); err != nil {
		return piUTF16Len(string(trimmed))
	}
	return piUTF16Len(buf.String())
}

func piCeilDiv4(chars int) int {
	if chars <= 0 {
		return 0
	}
	return (chars + 3) / 4
}

func piIsEmptyOrNullJSON(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null"))
}

func piIsJSONString(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && trimmed[0] == '"'
}

func piIsTruthyJSON(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return false
	}
	if bytes.Equal(trimmed, []byte("null")) || bytes.Equal(trimmed, []byte("false")) || bytes.Equal(trimmed, []byte(`""`)) || bytes.Equal(trimmed, []byte("0")) {
		return false
	}
	return true
}
