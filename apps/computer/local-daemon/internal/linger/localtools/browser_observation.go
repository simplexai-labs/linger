package localtools

import (
	"encoding/json"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// browserObservations belongs to one Operation's serialized browser calls.
type browserObservations struct {
	latest    browserObservation
	artifacts map[string]bool
}

// browserObservation is the last complete page read and its browser state.
type browserObservation struct {
	snapshot  *browserSnapshot
	url       string
	title     string
	status    string
	console   string
	tabs      map[string]string
	activeTab string
	downloads map[string]bool
}

type browserObservationDiff struct {
	tree         browserTreeDiff
	titleChanged bool
	fromTitle    string
	toTitle      string
	statusLine   string
	consoleLine  string
	tabsAdded    []string
	tabsRemoved  []string
	tabsChanged  []string
	downloads    []string
}

func (d browserObservationDiff) meaningful() bool {
	return d.titleChanged || d.statusLine != "" || d.consoleLine != "" ||
		len(d.tabsAdded) > 0 || len(d.tabsRemoved) > 0 || len(d.tabsChanged) > 0 ||
		len(d.downloads) > 0 || d.tree.rows > 0
}

// maxRemovedSamples keeps the disappearance report short: a removed
// reference cannot be used again, so only the count matters beyond a sample.
const maxRemovedSamples = 10

var (
	pageHTTPStatus = regexp.MustCompile(`(?m)^- HTTP status: (.+)$`)
	pageConsole    = regexp.MustCompile(`(?m)^- Console: (.+)$`)
	openTabsBlock  = regexp.MustCompile(`(?ms)^### Open tabs\n(.+?)(?:\n### |\z)`)
	resultBlock    = regexp.MustCompile(`(?ms)^### Result\n(.+?)(?:\n### |\z)`)
	openTabLine    = regexp.MustCompile(`^- (\d+): (?:\(current\) )?\[(.*)\]\((.*)\)(?: \[crashed\])?$`)
	snapshotBlock  = regexp.MustCompile("(?ms)^### Snapshot\\n```yaml\\n(.*?)\\n```")
	downloadEvent  = regexp.MustCompile(`(?m)^- Downloaded file .+ to "([^"\n]+)"\r?$`)
	markdownLink   = regexp.MustCompile(`\]\(([^)\n]+)\)`)
	consoleLog     = regexp.MustCompile(`^console-.*\.log$`)
)

// observeAction may replace the full snapshot with a diff against the last
// complete read of this page. The caller has already inlined snapshot files.
func (s *browserObservations) observeAction(name string, args, result json.RawMessage, output string, fullSnapshot bool) json.RawMessage {
	texts := resultTexts(result)
	snapshots := snapshotTexts(texts)
	current := observationFromText(name, texts, len(snapshots) > 0)
	before := s.latest
	if startsNewBrowserPage(name, args) || before.pageChanged(current) {
		before.snapshot = nil
	}
	if s.artifacts == nil {
		s.artifacts = make(map[string]bool)
	}
	collectArtifacts(texts, output, s.artifacts)

	if len(snapshots) == 0 || name == "browser_snapshot" && scopedBrowserSnapshot(args) {
		if current.tabs != nil {
			before.tabs, before.activeTab = current.tabs, current.activeTab
		}
		s.latest = before
		return result
	}
	if len(snapshots) == 1 && current.url != "" && current.activeTab != "" {
		if before.snapshot != nil && before.snapshot.text == snapshots[0] {
			current.snapshot = before.snapshot
		} else {
			current.snapshot = parseBrowserSnapshot(snapshots[0])
		}
	}
	current.downloads = setOf(scanDownloads(output, texts, s.artifacts))
	s.latest = current

	if fullSnapshot || name == "browser_snapshot" || name == "browser_tabs" || !before.snapshot.alignsWith(current.snapshot) {
		return result
	}
	diff := compareObservation(before, current)
	if before.snapshot != current.snapshot && !diff.tree.compare(before.snapshot.root, current.snapshot.root) {
		return result
	}
	return compactSnapshot(result, diff)
}

// Tab indices can be reused, including when closing the first of two tabs
// at the same URL. Mutating tab commands end the current observation.
func startsNewBrowserPage(name string, args json.RawMessage) bool {
	switch name {
	case "browser_navigate", "browser_navigate_back", "browser_close":
		return true
	case "browser_tabs":
		var tabs struct {
			Action string `json:"action"`
		}
		return json.Unmarshal(args, &tabs) != nil || tabs.Action != "list"
	}
	return false
}

func scopedBrowserSnapshot(args json.RawMessage) bool {
	var scope struct {
		Target string   `json:"target"`
		Depth  *float64 `json:"depth"`
		Boxes  bool     `json:"boxes"`
	}
	if len(args) == 0 {
		return false
	}
	return json.Unmarshal(args, &scope) != nil || scope.Target != "" || scope.Depth != nil || scope.Boxes
}

func (before browserObservation) pageChanged(current browserObservation) bool {
	return current.url != "" && before.url != current.url ||
		current.tabs != nil && before.activeTab != current.activeTab
}

// compareObservation diffs the current baseline against the previous one.
func compareObservation(before, current browserObservation) browserObservationDiff {
	var diff browserObservationDiff
	if before.title != current.title {
		diff.titleChanged, diff.fromTitle, diff.toTitle = true, before.title, current.title
	}
	if before.status != current.status {
		diff.statusLine = changedLine(before.status, current.status)
	}
	if before.console != current.console {
		diff.consoleLine = changedLine(before.console, current.console)
	}
	for address := range current.downloads {
		if !before.downloads[address] {
			diff.downloads = append(diff.downloads, address)
		}
	}
	// Tabs are keyed by their list index so two tabs on one address stay
	// distinct; the current marker is not part of the stored line.
	for index, line := range current.tabs {
		old, present := before.tabs[index]
		switch {
		case !present:
			diff.tabsAdded = append(diff.tabsAdded, line)
		case old != line:
			diff.tabsChanged = append(diff.tabsChanged, line)
		}
	}
	for index, line := range before.tabs {
		if _, present := current.tabs[index]; !present {
			diff.tabsRemoved = append(diff.tabsRemoved, line)
		}
	}
	sort.Strings(diff.tabsAdded)
	sort.Strings(diff.tabsRemoved)
	sort.Strings(diff.tabsChanged)
	sort.Strings(diff.downloads)
	return diff
}

// observationFromText reads the page header and tabs that frame a snapshot.
func observationFromText(name string, texts []string, hasSnapshot bool) browserObservation {
	var observation browserObservation
	for _, text := range texts {
		if match := pageURL.FindStringSubmatch(text); match != nil {
			observation.url = strings.TrimSpace(match[1])
		}
		if match := pageTitle.FindStringSubmatch(text); match != nil {
			observation.title = strings.TrimSpace(match[1])
		}
		if match := pageHTTPStatus.FindStringSubmatch(text); match != nil {
			observation.status = strings.TrimSpace(match[1])
		}
		if match := pageConsole.FindStringSubmatch(text); match != nil {
			observation.console = strings.TrimSpace(match[1])
		}
	}
	observation.tabs, observation.activeTab = parseTabs(texts)
	if observation.tabs == nil && name == "browser_tabs" {
		observation.tabs, observation.activeTab = parseResultTabs(texts)
	}
	if observation.tabs == nil && hasSnapshot {
		observation.tabs, observation.activeTab = singleTab(observation.url, observation.title)
	}
	return observation
}

// parseTabs reads the Open tabs section Playwright prints when the tab list
// or one of its headers changed. A missing section means the result did not
// report tabs, not that no tab is open.
func parseTabs(texts []string) (map[string]string, string) {
	var tabs map[string]string
	var active string
	for _, text := range texts {
		block := openTabsBlock.FindStringSubmatch(text)
		if block == nil {
			continue
		}
		tabs, active = parseTabLines(block[1])
	}
	return tabs, active
}

// parseResultTabs reads the tab list browser_tabs prints in the Result
// section when the call carries no snapshot.
func parseResultTabs(texts []string) (map[string]string, string) {
	for _, text := range texts {
		block := resultBlock.FindStringSubmatch(text)
		if block == nil {
			continue
		}
		if tabs, active := parseTabLines(block[1]); tabs != nil {
			return tabs, active
		}
	}
	return nil, ""
}

// parseTabLines keys tabs by their list index, so two tabs on one address
// stay distinct, and stores the line without the current marker.
func parseTabLines(block string) (map[string]string, string) {
	if strings.HasPrefix(strings.TrimSpace(block), "No open tabs.") {
		return map[string]string{}, ""
	}
	tabs := map[string]string{}
	var active string
	for _, raw := range strings.Split(strings.TrimSpace(block), "\n") {
		line := strings.TrimSpace(raw)
		match := openTabLine.FindStringSubmatch(line)
		if match == nil {
			continue
		}
		if strings.HasPrefix(line, "- "+match[1]+": (current) [") {
			active = match[1] + ": " + match[3]
			line = strings.Replace(line, ": (current) [", ": [", 1)
		}
		tabs[match[1]] = line
	}
	if len(tabs) == 0 {
		return nil, ""
	}
	return tabs, active
}

// singleTab is the only tab a snapshot-bearing result has when it prints no
// Open tabs section.
func singleTab(url, title string) (map[string]string, string) {
	if url == "" {
		return nil, ""
	}
	line := "- 0: [" + title + "](" + url + ")"
	return map[string]string{"0": line}, "0: " + url
}

// changedLine renders one value that appeared, disappeared or became other.
func changedLine(before, after string) string {
	switch {
	case before == "":
		return after
	case after == "":
		return "none (was " + before + ")"
	default:
		return before + " -> " + after
	}
}

// render returns the compact report that replaces the full tree.
func (d browserObservationDiff) render() string {
	var out strings.Builder
	out.WriteString("### Snapshot diff\n")
	if !d.meaningful() {
		out.WriteString("no_change: the page did not change; existing refs remain valid.\n")
		return out.String()
	}
	if d.titleChanged {
		fmt.Fprintf(&out, "- title: %s -> %s\n", d.fromTitle, d.toTitle)
	}
	if d.statusLine != "" {
		fmt.Fprintf(&out, "- http status: %s\n", d.statusLine)
	}
	if d.consoleLine != "" {
		fmt.Fprintf(&out, "- console: %s\n", d.consoleLine)
	}
	for _, tab := range d.tabsAdded {
		fmt.Fprintf(&out, "- tabs added: %s\n", tab)
	}
	for _, tab := range d.tabsChanged {
		fmt.Fprintf(&out, "- tabs changed: %s\n", tab)
	}
	for _, tab := range d.tabsRemoved {
		fmt.Fprintf(&out, "- tabs removed: %s\n", tab)
	}
	for _, name := range d.downloads {
		fmt.Fprintf(&out, "- download: %s\n", name)
	}
	if len(d.tree.changed) > 0 {
		out.WriteString("- elements changed:\n")
		writeSnapshotBranches(&out, "~", d.tree.changed)
	}
	if len(d.tree.added) > 0 {
		out.WriteString("- elements added:\n")
		writeSnapshotBranches(&out, "+", d.tree.added)
	}
	if len(d.tree.removed) > 0 {
		out.WriteString("- elements removed:\n")
		writeSnapshotBranches(&out, "-", d.tree.removed[:min(len(d.tree.removed), maxRemovedSamples)])
		if more := len(d.tree.removed) - maxRemovedSamples; more > 0 {
			fmt.Fprintf(&out, "  ... %d more removed\n", more)
		}
	}
	if d.tree.rows > 0 {
		out.WriteString("Unchanged refs keep their identifiers; call browser_snapshot for the full tree.\n")
	}
	return out.String()
}

// writeSnapshotBranches preserves indentation within each reported branch.
func writeSnapshotBranches(out *strings.Builder, marker string, branches []browserTreeChange) {
	for _, branch := range branches {
		rows := branch.rows
		first := strings.TrimLeft(rows[0], " ")
		indent := rows[0][:len(rows[0])-len(first)]
		fmt.Fprintf(out, "  %s %s\n", marker, first)
		for _, row := range rows[1:] {
			fmt.Fprintf(out, "    %s\n", strings.TrimPrefix(row, indent))
		}
		if branch.parent != "" {
			fmt.Fprintf(out, "    under %s\n", branch.parent)
		}
	}
}

// compactSnapshot replaces the inlined snapshot with the compact report.
func compactSnapshot(result json.RawMessage, diff browserObservationDiff) json.RawMessage {
	var reply map[string]any
	if json.Unmarshal(result, &reply) != nil {
		return result
	}
	content, _ := reply["content"].([]any)
	report := diff.render()
	changed := false
	for _, item := range content {
		part, _ := item.(map[string]any)
		text, ok := part["text"].(string)
		if part["type"] != "text" || !ok {
			continue
		}
		if location := snapshotBlock.FindStringIndex(text); location != nil {
			if len(report) >= location[1]-location[0] {
				return result
			}
			part["text"] = text[:location[0]] + report + text[location[1]:]
			changed = true
		}
	}
	if !changed {
		return result
	}
	metadata, _ := reply["_meta"].(map[string]any)
	if metadata == nil {
		metadata = make(map[string]any)
		reply["_meta"] = metadata
	}
	metadata["linger/browserSnapshotDiff"] = true
	encoded, err := json.Marshal(reply)
	if err != nil {
		return result
	}
	return encoded
}

// resultTexts returns the text parts of one MCP tool result.
func resultTexts(result json.RawMessage) []string {
	var reply struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if json.Unmarshal(result, &reply) != nil {
		return nil
	}
	texts := make([]string, 0, len(reply.Content))
	for _, item := range reply.Content {
		if item.Type == "text" {
			texts = append(texts, item.Text)
		}
	}
	return texts
}

// snapshotTexts returns every inlined accessibility tree in the result.
func snapshotTexts(texts []string) []string {
	var snapshots []string
	for _, text := range texts {
		for _, match := range snapshotBlock.FindAllStringSubmatch(text, -1) {
			snapshots = append(snapshots, match[1])
		}
	}
	return snapshots
}

// collectArtifacts adds every link to a file inside this Operation's output
// directory, including screenshots and console or network logs.
func collectArtifacts(texts []string, output string, artifacts map[string]bool) {
	for _, text := range texts {
		for _, match := range screenshotLink.FindAllStringSubmatch(text, -1) {
			artifacts[path.Base(match[1])] = true
		}
		for _, match := range markdownLink.FindAllStringSubmatch(text, -1) {
			if name := outputArtifact(output, match[1]); name != "" {
				artifacts[name] = true
			}
		}
	}
}

// scanDownloads lists the files a user downloaded. The Events section names
// completed downloads; the output directory catches files whose event arrived
// after the action. Links to files inside this Operation's output directory
// are Playwright artifacts, not downloads, and the console log is written
// without a link.
func scanDownloads(output string, texts []string, artifacts map[string]bool) []string {
	found := map[string]bool{}
	for _, text := range texts {
		for _, match := range downloadEvent.FindAllStringSubmatch(text, -1) {
			found[path.Base(filepath.ToSlash(match[1]))] = true
		}
	}
	if output != "" {
		entries, err := os.ReadDir(output)
		if err == nil {
			for _, entry := range entries {
				if entry.IsDir() {
					continue
				}
				name := entry.Name()
				lower := strings.ToLower(name)
				switch {
				case strings.HasSuffix(lower, ".yml"), strings.HasSuffix(lower, ".yaml"),
					strings.HasSuffix(lower, ".crdownload"), strings.HasSuffix(lower, ".tmp"),
					consoleLog.MatchString(lower), artifacts[name]:
					continue
				}
				if info, err := entry.Info(); err == nil && info.Mode().IsRegular() {
					found[name] = true
				}
			}
		}
	}
	if len(found) == 0 {
		return nil
	}
	names := make([]string, 0, len(found))
	for name := range found {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// outputArtifact returns the file name of a link that points inside this
// Operation's output directory, or empty for a page or remote link.
func outputArtifact(output, target string) string {
	if output == "" || strings.Contains(target, "://") {
		return ""
	}
	marker := path.Base(filepath.ToSlash(output)) + "/"
	slash := filepath.ToSlash(target)
	index := strings.Index(slash, marker)
	if index < 0 {
		return ""
	}
	rest := slash[index+len(marker):]
	if hash := strings.IndexByte(rest, '#'); hash >= 0 {
		rest = rest[:hash]
	}
	if rest == "" || strings.HasSuffix(rest, "/") {
		return ""
	}
	return path.Base(rest)
}

func setOf(values []string) map[string]bool {
	set := make(map[string]bool, len(values))
	for _, value := range values {
		set[value] = true
	}
	return set
}
