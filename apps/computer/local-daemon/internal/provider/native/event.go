package native

import "time"

type EventKind string

const (
	EventText      EventKind = "text"
	EventReasoning EventKind = "thinking"
	EventToolCall  EventKind = "tool-use"
	// EventToolCallStart marks that the model started composing a tool call
	// before execution arguments are complete.
	EventToolCallStart EventKind = "tool-use-start"
	EventToolOutput    EventKind = "tool-result"
	EventToolProgress  EventKind = "tool-progress"
	EventStatus        EventKind = "status"
	EventError         EventKind = "error"
	EventLog           EventKind = "log"
	EventPlan          EventKind = "plan"
	EventHumanPrompt   EventKind = "human-interaction"
	// EventBackgroundWaiting reports that a Turn went idle on model output while
	// one or more native background tools remain open.
	EventBackgroundWaiting EventKind = "background-waiting"
	// EventBackgroundResumed reports that a Turn resumed active model execution
	// after waiting on background tools.
	EventBackgroundResumed EventKind = "background-resumed"
	// EventModelResponse is one completed model request; Response holds it.
	EventModelResponse EventKind = "model-response"
)

// BackgroundTool describes one open background tool call held while a Turn waits.
type BackgroundTool struct {
	CallID    string
	ToolName  string
	StartedAt time.Time
}

// Event is one progress observation of a Run.
type Event struct {
	// SentAt is when the turn was dispatched (turn-started status events).
	SentAt time.Time
	// ObservedAt is when the Daemon read the frame behind a text or tool event.
	ObservedAt time.Time
	// ModelMessageID names the model message behind text or reasoning events.
	// Tool events never copy it into ID.
	ModelMessageID string
	Kind           EventKind
	ID             string
	Body           string
	Title          string
	// Complete marks that a reasoning block has ended, so buffered text
	// without a newline or closing bold heading becomes its title.
	Complete     bool
	ToolName     string
	InvocationID string
	Input        map[string]any
	Output       string
	Status       string
	Level        string
	SessionID    string
	// TurnID on a status event means the turn started.
	TurnID        string
	ProcessReused *bool
	// ActivityKind is the Runtime-neutral class of a tool call (Activity*
	// constants). Empty means ActivityTool.
	ActivityKind string
	// ActivityTitle is the Runtime's own one-line description of a tool
	// call, such as the description Claude writes for a Bash command.
	ActivityTitle string
	// Response is the completed model request of an EventModelResponse.
	Response *ModelResponse
	// BackgroundTools lists open background tools on EventBackgroundWaiting.
	BackgroundTools []BackgroundTool
	// BackgroundTrigger names what resumed execution on EventBackgroundResumed.
	BackgroundTrigger string
}
