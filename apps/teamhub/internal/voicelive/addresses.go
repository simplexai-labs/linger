package voicelive

import (
	"regexp"
	"slices"
	"strings"
)

// knownSentLimit bounds the recent recipients the live voice is given.
const knownSentLimit = 10

// emailInText finds addresses written inside free text, such as a Profile.
var emailInText = regexp.MustCompile(`[^\s@,;:<>"'()\[\]]+@[^\s@,;:<>"'()\[\]]+\.[A-Za-z]{2,}`)

// KnownAddresses is what the live voice checks a heard recipient against:
// the user's own addresses found in own, then the distinct recipients in sent
// (address fields, newest first) that are not their own, at most ten.
func KnownAddresses(own, sent []string) (mine, recent []string) {
	seen := map[string]bool{}
	for _, text := range own {
		for _, address := range emailInText.FindAllString(text, -1) {
			if key := strings.ToLower(address); !seen[key] {
				seen[key] = true
				mine = append(mine, address)
			}
		}
	}
	for _, field := range sent {
		for _, address := range strings.FieldsFunc(field, recipientSeparator) {
			address = strings.TrimSpace(address)
			key := strings.ToLower(address)
			if !emailAddress.MatchString(address) || seen[key] {
				continue
			}
			seen[key] = true
			recent = append(recent, address)
			if len(recent) == knownSentLimit {
				return mine, recent
			}
		}
	}
	return mine, recent
}

// RecipientSuggestion is a known address, or a heard name at a known
// domain, that a recipient the speech model may have misheard resembles.
type RecipientSuggestion struct {
	Heard     string `json:"heard"`
	Suggested string `json:"suggested"`
}

// SuggestRecipients finds, for each address in to and cc that is not one of
// known, the one it most resembles: a known address whose part before @ is
// close to the heard one, or else the heard name at a known domain close to
// the heard one. The parts are compared apart, since a mishearing often
// keeps one of them. Malformed fields suggest nothing; the canvas rejects
// them on its own.
func SuggestRecipients(to, cc string, known []string) []RecipientSuggestion {
	listed := map[string]bool{}
	domains := []string{}
	for _, address := range known {
		key := strings.ToLower(address)
		listed[key] = true
		if _, domain, ok := strings.Cut(key, "@"); ok && !slices.Contains(domains, domain) {
			domains = append(domains, domain)
		}
	}
	var suggestions []RecipientSuggestion
	seen := map[string]bool{}
	for _, field := range []string{to, cc} {
		normalized, ok := recipients(field)
		if !ok {
			return nil
		}
		for _, heard := range strings.FieldsFunc(normalized, recipientSeparator) {
			key := strings.ToLower(heard)
			if listed[key] || seen[key] {
				continue
			}
			seen[key] = true
			if suggested := suggestRecipient(key, known, domains); suggested != "" {
				suggestions = append(suggestions, RecipientSuggestion{Heard: heard, Suggested: suggested})
			}
		}
	}
	return suggestions
}

func suggestRecipient(heard string, known, domains []string) string {
	name, domain, _ := strings.Cut(heard, "@")
	best, bestExact, bestScore := "", false, 0.0
	for _, address := range known {
		knownName, knownDomain, _ := strings.Cut(strings.ToLower(address), "@")
		nameScore := partSimilarity(name, knownName)
		if nameScore == 0 {
			continue
		}
		// The same name wins over a near one; the domain then breaks ties.
		exact, score := name == knownName, nameScore+domainSimilarity(domain, knownDomain)
		if best == "" || exact && !bestExact || exact == bestExact && score > bestScore {
			best, bestExact, bestScore = address, exact, score
		}
	}
	if best != "" || slices.Contains(domains, domain) {
		return best
	}
	for _, knownDomain := range domains {
		if score := domainSimilarity(domain, knownDomain); score > bestScore {
			best, bestScore = name+"@"+knownDomain, score
		}
	}
	return best
}

// domainSimilarity compares domains by what comes before the last label. A
// domain with that same part matches only when its ending is a near
// mishearing too (.co for .com), since .org or .cn is often another place.
func domainSimilarity(heard, known string) float64 {
	if heard == known {
		return 1
	}
	heardLabel, heardEnd := splitTopLevel(heard)
	knownLabel, knownEnd := splitTopLevel(known)
	if heardLabel != knownLabel {
		return partSimilarity(heardLabel, knownLabel)
	}
	if strings.HasPrefix(heardEnd, knownEnd) || strings.HasPrefix(knownEnd, heardEnd) || editDistance([]rune(heardEnd), []rune(knownEnd)) <= 1 {
		return 1
	}
	return 0
}

func splitTopLevel(domain string) (label, end string) {
	if i := strings.LastIndexByte(domain, '.'); i > 0 {
		return domain[:i], domain[i+1:]
	}
	return domain, ""
}

// partSimilarity is the Jaro-Winkler similarity of two address parts that a
// mishearing could turn into each other, and 0 for any other pair: a few
// edits apart (one per four characters, at least one), or sharing their
// first four characters while remaining similar overall.
func partSimilarity(heard, known string) float64 {
	if heard == known {
		return 1
	}
	a, b := []rune(heard), []rune(known)
	shorter := min(len(a), len(b))
	if shorter < 3 {
		return 0
	}
	score := jaroWinkler(a, b)
	if editDistance(a, b) <= max(1, shorter/4) || commonPrefix(a, b) >= 4 && score >= 0.85 {
		return score
	}
	return 0
}

// editDistance counts insertions, deletions, substitutions and swaps of two
// neighbours (optimal string alignment).
func editDistance(a, b []rune) int {
	rows := make([][]int, len(a)+1)
	for i := range rows {
		rows[i] = make([]int, len(b)+1)
		rows[i][0] = i
	}
	for j := range rows[0] {
		rows[0][j] = j
	}
	for i := 1; i <= len(a); i++ {
		for j := 1; j <= len(b); j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			rows[i][j] = min(rows[i-1][j]+1, rows[i][j-1]+1, rows[i-1][j-1]+cost)
			if i > 1 && j > 1 && a[i-1] == b[j-2] && a[i-2] == b[j-1] {
				rows[i][j] = min(rows[i][j], rows[i-2][j-2]+1)
			}
		}
	}
	return rows[len(a)][len(b)]
}

func commonPrefix(a, b []rune) int {
	n := 0
	for n < len(a) && n < len(b) && a[n] == b[n] {
		n++
	}
	return n
}

func jaroWinkler(a, b []rune) float64 {
	window := max(max(len(a), len(b))/2-1, 0)
	matchedA, matchedB := make([]bool, len(a)), make([]bool, len(b))
	matches := 0
	for i := range a {
		for j := max(0, i-window); j < min(len(b), i+window+1); j++ {
			if !matchedB[j] && a[i] == b[j] {
				matchedA[i], matchedB[j] = true, true
				matches++
				break
			}
		}
	}
	if matches == 0 {
		return 0
	}
	transpositions, j := 0, 0
	for i := range a {
		if !matchedA[i] {
			continue
		}
		for !matchedB[j] {
			j++
		}
		if a[i] != b[j] {
			transpositions++
		}
		j++
	}
	m := float64(matches)
	jaro := (m/float64(len(a)) + m/float64(len(b)) + (m-float64(transpositions)/2)/m) / 3
	return jaro + float64(min(commonPrefix(a, b), 4))*0.1*(1-jaro)
}
