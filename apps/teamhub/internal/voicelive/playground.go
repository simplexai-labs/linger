package voicelive

import (
	"fmt"
	"path"
	"strings"
	"time"
)

// The live voice reads and posts files in the folders a Meta Agent sees under
// ./playground: <task id> holds a delegated Task's output, <room id> the
// Room's own files. Paths are written the way the Meta and its Tasks write
// them, so a path from a Task's report works as it is.
const (
	ToolListFiles = "ls"
	ToolReadFile  = "cat"
	ToolSendCard  = "send_card"
)

// PlaygroundRoot starts every path.
const PlaygroundRoot = "./playground/"

// MaxCardFiles is how many files one card carries.
const MaxCardFiles = 5

// PathArguments names one path.
type PathArguments struct {
	Path string `json:"path"`
}

// SendCardArguments is one card: a title, a one-line result and files.
type SendCardArguments struct {
	Title   string   `json:"title"`
	Content string   `json:"content"`
	Attach  []string `json:"attach"`
}

func init() {
	Tools = append(Tools,
		Tool{Name: ToolListFiles, Description: "List a folder on the user's computer, like ls -lh: size, modified time (UTC) and name; folders end with /. " +
			"./playground/ lists the folders you can open: one per task of this call (./playground/<task folder>/, the folder its report names) and this room's own folder. " +
			"Never guess a file exists: list first.",
			Parameters: objectSchema(nil, map[string]any{"path": stringProperty("A folder such as ./playground/workitem_1d09.../; empty for ./playground/")})},
		Tool{Name: ToolReadFile, Description: "Print a text file on the user's computer, like cat: its first 3000 characters, and how much more there is. " +
			"not_text means it is an image, video or other binary file: send it with send_card instead of reading it.",
			Parameters: objectSchema([]string{"path"}, map[string]any{"path": stringProperty("A file such as ./playground/workitem_1d09.../report.md")})},
		Tool{Name: ToolSendCard, Description: "Post a card in the chat as yourself, like teamhub message card --attach: a one-line title, a one-line result and up to 5 files from ./playground. " +
			"Use it to deliver a finished task's result with its files; each file becomes a document in the chat. It never sends as the user. " +
			"Say it is in the chat only after it returns delivered; its documents can then be opened with page_action open_document. " +
			"A task that failed is not a card: say what happened. upload_failed or outcome_unknown means it did not go out or may have: never send it twice before checking the chat.",
			Parameters: objectSchema([]string{"title", "content"}, map[string]any{
				"title":   map[string]any{"type": "string", "maxLength": 120, "description": "The card's title, one line"},
				"content": stringProperty("The one-line result, in the user's language"),
				"attach": map[string]any{"type": "array", "maxItems": MaxCardFiles, "items": map[string]any{"type": "string"},
					"description": "Files such as ./playground/workitem_1d09.../cartoon.png; no folders"},
			})},
	)
}

// PlaygroundPath is a path split into the folder it names and the path
// inside that folder. Folder is empty for ./playground/ itself.
type PlaygroundPath struct {
	Folder, Inside string
}

// ParsePlaygroundPath reads ./playground/<folder>/<inside>. It is false for a
// path outside ./playground or one that climbs out of its folder.
func ParsePlaygroundPath(raw string) (PlaygroundPath, bool) {
	cleaned := strings.TrimSpace(raw)
	if strings.ContainsAny(cleaned, "\\\x00") || strings.HasPrefix(cleaned, "/") {
		return PlaygroundPath{}, false
	}
	for _, segment := range strings.Split(cleaned, "/") {
		if segment == ".." {
			return PlaygroundPath{}, false
		}
	}
	cleaned = path.Clean(cleaned)
	if cleaned == "." || cleaned == "playground" {
		return PlaygroundPath{}, true
	}
	rest, ok := strings.CutPrefix(cleaned, "playground/")
	if !ok {
		return PlaygroundPath{}, false
	}
	folder, inside, _ := strings.Cut(rest, "/")
	return PlaygroundPath{Folder: folder, Inside: inside}, true
}

// ListEntry is one row of a folder listing.
type ListEntry struct {
	Name      string
	Directory bool
	Size      int64
	Modified  time.Time
}

// FormatListing prints a folder like ls -lh. total counts every entry the
// folder holds, so a cut listing says how many are left out.
func FormatListing(folder string, entries []ListEntry, total int) string {
	var listing strings.Builder
	listing.WriteString(folder + "\n")
	if total == 0 {
		listing.WriteString("(empty)\n")
	}
	for _, entry := range entries {
		size, name := HumanSize(entry.Size), entry.Name
		if entry.Directory {
			size, name = "-", name+"/"
		}
		modified := "-"
		if !entry.Modified.IsZero() {
			modified = entry.Modified.UTC().Format("2006-01-02 15:04Z")
		}
		fmt.Fprintf(&listing, "%5s  %s  %s\n", size, modified, name)
	}
	if more := total - len(entries); more > 0 {
		fmt.Fprintf(&listing, "… %d more\n", more)
	}
	return listing.String()
}

// HumanSize prints a byte count the way ls -lh does: 512, 3.7K, 197K, 12M.
func HumanSize(size int64) string {
	value, unit := float64(size), ""
	for _, next := range []string{"K", "M", "G", "T"} {
		if value < 1024 {
			break
		}
		value, unit = value/1024, next
	}
	if unit == "" {
		return fmt.Sprintf("%d", size)
	}
	if value < 10 {
		return fmt.Sprintf("%.1f%s", value, unit)
	}
	return fmt.Sprintf("%.0f%s", value, unit)
}
