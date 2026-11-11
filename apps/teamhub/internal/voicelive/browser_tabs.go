package voicelive

import (
	"regexp"
	"strconv"
	"strings"
)

var browserTabLinePattern = regexp.MustCompile(`^- (\d+):( \(current\))? \[`)

// BrowserTabs reads the open tabs a browser page text lists: how many there
// are and the index of the current one. A page with a single tab lists none,
// so it reads as one tab, the current one.
func BrowserTabs(page string) (count, current int) {
	_, section, found := strings.Cut(page, "### Open tabs\n")
	if !found {
		return 1, 0
	}
	section, _, _ = strings.Cut(section, "\n###")
	for _, line := range strings.Split(section, "\n") {
		match := browserTabLinePattern.FindStringSubmatch(line)
		if match == nil {
			continue
		}
		count++
		if match[2] != "" {
			current, _ = strconv.Atoi(match[1])
		}
	}
	if count == 0 {
		return 1, 0
	}
	return count, current
}
