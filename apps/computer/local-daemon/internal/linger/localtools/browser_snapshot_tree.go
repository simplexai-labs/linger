package localtools

import (
	"regexp"
	"slices"
	"strings"

	"gopkg.in/yaml.v3"
)

// A snapshot retains the order and ownership of its rows. Playwright renders
// details such as /url and text as child rows without refs of their own.
type browserSnapshot struct {
	text  string
	root  browserSnapshotNode
	order []string
	owner map[string]string
}

type browserSnapshotNode struct {
	ref      string
	rows     []string
	children []browserSnapshotNode
}

// The label is a YAML key or scalar. Playwright puts the ref after the role,
// quoted name and state attributes, followed only by optional geometry.
var snapshotNodeRef = regexp.MustCompile(` \[ref=([A-Za-z0-9_-]+)\](?: \[cursor=pointer\])?(?: \[box=[^\[\]]+\])?$`)

func parseBrowserSnapshot(text string) *browserSnapshot {
	var document yaml.Node
	if err := yaml.Unmarshal([]byte(text), &document); err != nil || len(document.Content) != 1 {
		return nil
	}
	lines := strings.Split(text, "\n")
	tree := &browserSnapshot{text: text, owner: make(map[string]string)}
	next := 0
	children, ok := tree.parseChildren(document.Content[0], lines, &next, "")
	if !ok || next != len(lines) {
		return nil
	}
	tree.root = browserSnapshotNode{rows: lines, children: children}
	return tree
}

// Playwright's tree has one sequence item per rendered line. A format we
// cannot account for stays in the original snapshot.
func (s *browserSnapshot) parseChildren(sequence *yaml.Node, lines []string, next *int, owner string) ([]browserSnapshotNode, bool) {
	if sequence.Kind != yaml.SequenceNode {
		return nil, false
	}
	children := make([]browserSnapshotNode, 0, len(sequence.Content))
	for _, item := range sequence.Content {
		first := *next
		if first >= len(lines) || item.Line != first+1 || !strings.HasPrefix(strings.TrimLeft(lines[first], " "), "- ") {
			return nil, false
		}
		*next = first + 1

		label := item
		var value *yaml.Node
		if item.Kind == yaml.MappingNode && len(item.Content) == 2 {
			label, value = item.Content[0], item.Content[1]
		}
		if label.Kind != yaml.ScalarNode {
			return nil, false
		}
		child := browserSnapshotNode{}
		childOwner := owner
		if match := snapshotNodeRef.FindStringSubmatch(label.Value); match != nil {
			child.ref = match[1]
			if _, seen := s.owner[child.ref]; seen {
				return nil, false
			}
			s.owner[child.ref] = owner
			s.order = append(s.order, child.ref)
			childOwner = child.ref
		}
		if value != nil && value.Kind != yaml.ScalarNode {
			var ok bool
			child.children, ok = s.parseChildren(value, lines, next, childOwner)
			if !ok {
				return nil, false
			}
		}
		child.rows = lines[first:*next]
		children = append(children, child)
	}
	return children, true
}

// Retained refs anchor a compact diff. Without one, a same-URL load can look
// like an ordinary update. Moving an anchor requires the full tree for context.
func (s *browserSnapshot) alignsWith(current *browserSnapshot) bool {
	if s == nil || current == nil {
		return false
	}
	if s == current {
		return len(s.order) > 0
	}
	var retained []string
	for _, ref := range s.order {
		if owner, exists := current.owner[ref]; exists {
			if owner != s.owner[ref] {
				return false
			}
			retained = append(retained, ref)
		}
	}
	if len(retained) == 0 {
		return false
	}
	next := 0
	for _, ref := range current.order {
		if _, exists := s.owner[ref]; exists {
			if ref != retained[next] {
				return false
			}
			next++
		}
	}
	return true
}

type browserTreeDiff struct {
	added   []browserTreeChange
	changed []browserTreeChange
	removed []browserTreeChange
	rows    int
}

type browserTreeChange struct {
	rows   []string
	parent string
}

// A large change is easier to read in the complete tree.
const maxSnapshotDiffRows = 40

// compare reports a branch when one of its unreferenced children changes, so
// the reader sees which element owns the new text or property.
func (d *browserTreeDiff) compare(before, current browserSnapshotNode) bool {
	oldRefs, newRefs := before.childRefs(), current.childRefs()
	if !slices.Equal(before.childLayout(newRefs), current.childLayout(oldRefs)) {
		if current.ref == "" {
			return false
		}
		d.changed = append(d.changed, browserTreeChange{rows: current.rows})
		d.rows += len(current.rows)
		return d.rows <= maxSnapshotDiffRows
	}
	if current.ref != "" && before.rows[0] != current.rows[0] {
		d.changed = append(d.changed, browserTreeChange{rows: current.rows[:1]})
		d.rows++
	}
	for _, child := range current.children {
		if child.ref == "" {
			continue
		}
		if old, exists := oldRefs[child.ref]; exists {
			if !d.compare(old, child) {
				return false
			}
		} else {
			d.added = append(d.added, browserTreeChange{rows: child.rows, parent: current.referencedRow()})
			d.rows += len(child.rows)
		}
	}
	for _, child := range before.children {
		if _, exists := newRefs[child.ref]; child.ref != "" && !exists {
			d.removed = append(d.removed, browserTreeChange{rows: child.rows[:1], parent: before.referencedRow()})
			d.rows += len(child.rows)
		}
	}
	return d.rows <= maxSnapshotDiffRows
}

func (n browserSnapshotNode) referencedRow() string {
	if n.ref == "" {
		return ""
	}
	return strings.TrimSpace(n.rows[0])
}

func (n browserSnapshotNode) childRefs() map[string]browserSnapshotNode {
	if len(n.children) == 0 {
		return nil
	}
	refs := make(map[string]browserSnapshotNode)
	for _, child := range n.children {
		if child.ref != "" {
			refs[child.ref] = child
		}
	}
	return refs
}

// Retained direct children delimit the anonymous content. Including those
// anchors detects a text row that moved past a sibling with a ref.
func (n browserSnapshotNode) childLayout(otherRefs map[string]browserSnapshotNode) []string {
	var layout []string
	for _, child := range n.children {
		if child.ref == "" {
			layout = append(layout, child.rows...)
		} else if _, retained := otherRefs[child.ref]; retained {
			layout = append(layout, child.ref)
		}
	}
	return layout
}
