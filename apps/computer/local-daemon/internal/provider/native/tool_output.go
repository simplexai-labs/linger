package native

const (
	// toolOutputTokens is the most one tool result may keep when the model's
	// window is unknown: Codex's global limit, in its bytes/4 token estimate,
	// before Codex cuts out the middle.
	toolOutputTokens = 12000
	// toolOutputWindowPercent is the share of a known window one tool result
	// may take; the rest holds the instructions, the history and the other
	// tool results of the turn.
	toolOutputWindowPercent = 15
	// minToolOutputTokens keeps a small window's limit large enough to read a
	// page of a file or a command's error.
	minToolOutputTokens = 4000
	// maxToolOutputTokens keeps a large window's results as small as Claude
	// keeps its own Read and MCP results.
	maxToolOutputTokens = 25000
)

// toolOutputTokenLimit sizes the tool output limit by the model's context
// window: 15% of it, between minToolOutputTokens and maxToolOutputTokens.
// Codex estimates four bytes per token, which dense or binary output can
// exceed threefold. A zero window is unknown and keeps toolOutputTokens.
func toolOutputTokenLimit(contextWindow int) int {
	if contextWindow <= 0 {
		return toolOutputTokens
	}
	return min(max(contextWindow*toolOutputWindowPercent/100, minToolOutputTokens), maxToolOutputTokens)
}
