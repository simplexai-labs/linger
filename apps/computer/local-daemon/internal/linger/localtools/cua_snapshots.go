package localtools

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"sync"
)

// snapshotRowsKept bounds how many reads the Computer remembers, across
// windows. Each input to the Computer's own browser adds about three reads
// (the tab check, the read after it and the tab count), and an Agent acts on
// its latest read; a full browser tree is a few hundred kilobytes, so the
// bound also caps memory. A token whose read was dropped stays as it is.
const snapshotRowsKept = 16

// snapshotRows remembers the rows of the window reads that pass through one
// driver connection. Cua keeps one snapshot per window, and any read replaces
// it, including the Computer's own reads between the Agent's read and its
// input, such as the tab count of the Computer's own browser. remap carries a
// token of an older read over to the current snapshot when that row reads the
// same in both, so the Computer's own reads never stale the Agent's tokens.
type snapshotRows struct {
	mu sync.Mutex
	// reads maps a snapshot_id to its window and its rows by index.
	reads map[string]snapshotRead
	order []string
	// current is, per window, the snapshot_id of its latest read, or empty
	// when a script may have read it since.
	current map[string]string
	// seq numbers the reads; fence is the last read before the latest input.
	// An input can change the page, so a read from before it is never
	// carried over, even where a row reads the same.
	seq, fence int
}

type snapshotRead struct {
	window string
	rows   map[string]string
	seq    int
}

func newSnapshotRows() *snapshotRows {
	return &snapshotRows{reads: map[string]snapshotRead{}, current: map[string]string{}}
}

// observe records the rows of a read, or forgets the current snapshots after
// a script, whose reads run inside the driver.
func (s *snapshotRows) observe(params any, result json.RawMessage) {
	call, _ := params.(map[string]any)
	name, _ := call["name"].(string)
	if name == "run_script" {
		s.mu.Lock()
		clear(s.current)
		s.mu.Unlock()
		return
	}
	if name != "get_window_state" {
		return
	}
	var reply struct {
		Structured struct {
			Snapshot string  `json:"snapshot_id"`
			PID      float64 `json:"pid"`
			Window   float64 `json:"window_id"`
			Tree     string  `json:"tree_markdown"`
			Diff     string  `json:"tree_diff"`
			Since    string  `json:"since"`
			Status   string  `json:"since_status"`
		} `json:"structuredContent"`
	}
	if json.Unmarshal(result, &reply) != nil || reply.Structured.Snapshot == "" {
		return
	}
	read := reply.Structured
	window := fmt.Sprintf("%g:%g", read.PID, read.Window)
	rows := map[string]string{}
	s.mu.Lock()
	defer s.mu.Unlock()
	text := read.Tree
	if read.Status == "diff" {
		text = read.Diff
		// Rows a diff does not list keep their index, unless Cua's
		// "reindexed:" line, the only sign it gives, says the indices
		// shifted.
		if base, ok := s.reads[read.Since]; ok && base.window == window && !strings.Contains(read.Diff, "reindexed:") {
			for index, row := range base.rows {
				rows[index] = row
			}
		}
	}
	for _, line := range strings.Split(text, "\n") {
		trimmed := strings.TrimLeft(line, " ")
		removed := strings.HasPrefix(trimmed, "- [") && read.Status == "diff"
		index, row, ok := snapshotRow(trimmed)
		if !ok {
			continue
		}
		if removed {
			delete(rows, index)
			continue
		}
		rows[index] = row
	}
	if _, known := s.reads[read.Snapshot]; !known {
		s.order = append(s.order, read.Snapshot)
	}
	s.seq++
	s.reads[read.Snapshot] = snapshotRead{window: window, rows: rows, seq: s.seq}
	s.current[window] = read.Snapshot
	for len(s.order) > snapshotRowsKept {
		delete(s.reads, s.order[0])
		s.order = s.order[1:]
	}
}

// snapshotRow splits a row such as `- [12] AXLink "Kettle"` or a diff row
// such as `~ [12] AXLink "Kettle"` into its index and the row from the index
// on. Indentation differs between a full and a filtered read, so it is
// dropped.
func snapshotRow(line string) (index, row string, ok bool) {
	for _, mark := range []string{"- ", "+ ", "~ "} {
		line = strings.TrimPrefix(line, mark)
	}
	if !strings.HasPrefix(line, "[") {
		return "", "", false
	}
	index, _, ok = strings.Cut(line[1:], "] ")
	if !ok || index == "" || strings.Trim(index, "0123456789") != "" {
		return "", "", false
	}
	return index, line, true
}

// scriptToken finds an element token written into a script or its args.
var scriptToken = regexp.MustCompile(`\bs[0-9a-f]{8}:[0-9]+\b`)

// remap points element_token, and each token written into a script, at the
// window's current snapshot when the token names an older read whose row
// reads the same there. A row that changed, or a read the Computer does not
// remember, keeps its token, which Cua then refuses as stale.
func (s *snapshotRows) remap(arguments map[string]any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if token, ok := arguments["element_token"].(string); ok {
		arguments["element_token"] = s.carry(token)
	}
	if script, ok := arguments["script"].(string); ok {
		arguments["script"] = scriptToken.ReplaceAllStringFunc(script, s.carry)
	}
}

// sent fences off every read so far: the input just sent may have changed
// the page, so a token of an earlier read must not land on a row that only
// reads the same. A read changes nothing, so it fences nothing: the Agent's
// own read must still carry over the Computer's reads before its next input.
func (s *snapshotRows) sent(name string) {
	if readTools[name] {
		return
	}
	s.mu.Lock()
	s.fence = s.seq
	s.mu.Unlock()
}

// readTools only read the screen, so the page a token names stays as it was.
var readTools = map[string]bool{"list_windows": true, "get_window_state": true, "get_desktop_state": true, "get_screen_size": true, "get_cursor_position": true, "clipboard_read": true}

// carry returns the token on the current snapshot of its window, or the
// token itself.
func (s *snapshotRows) carry(token string) string {
	snapshot, index, ok := strings.Cut(token, ":")
	if !ok {
		return token
	}
	read, known := s.reads[snapshot]
	if !known || read.seq <= s.fence {
		return token
	}
	current := s.current[read.window]
	if current == "" || current == snapshot {
		return token
	}
	if row, ok := read.rows[index]; ok && s.reads[current].rows[index] == row {
		return current + ":" + index
	}
	return token
}
