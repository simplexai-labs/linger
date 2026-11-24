import { defineMessages } from "@/i18n/messages";

/**
 * What an Agent's Run is doing: the status line above the composer, the
 * Activity log, the Run controls and the background Tasks.
 */
export const runtimeStatusMessages = defineMessages("runtimeStatus", {
  // The state of a Run, as an Agent's avatar and the status line name it.
  stateCanceled: "Canceled",
  stateCompleted: "Completed",
  stateFailed: "Failed",
  stateNeedsAttention: "Needs attention",
  stateRecovering: "Recovering",
  stateStopped: "Stopped",
  stateThinking: "Thinking",
  stateTyping: "Typing",
  stateWaitingForInput: "Waiting for your input",
  stateWorking: "Working",
  starting: "Starting",
  preparingReply: "Preparing a reply",
  runStopped: "Run stopped",
  runCanceled: "Run canceled",
  runFailed: "Run failed",
  runFailedWith: "Run failed: {reason}",
  followUpUnconfirmed: "Follow-up delivery unconfirmed",
  // An interrupted Run whose follow-ups may not have arrived.
  stoppedFollowUpUnconfirmed:
    "{reason}. Follow-up delivery unconfirmed. Resend it if the Agent did not answer.",
  elapsedMinutes: "{minutes}m",
  labeled: "{label}: {value}",
  openAgentStatusActivity: "Open Agent status activity",
  openAgentsWorkingActivity: "Open Agents working activity",
  // Stop and Resend beside the status line.
  stopAgentTask: "Stop {name}'s task",
  stop: "Stop",
  stopping: "Stopping",
  stopped: "Stopped",
  stopNotConfirmed: "Stop not confirmed. Check the task status, then retry.",
  resendFollowUp: "Resend unconfirmed follow-up to {name}",
  resend: "Resend",
  resent: "Resent",
  nothingToResend: "Nothing to resend",
  resendFailed: "Resend failed. Try again.",
  // Background Tasks of the Room's Meta.
  backgroundTasks: "Background tasks",
  backgroundTasksRunning: {
    one: "{count} task running in the background",
    other: "{count} tasks running in the background",
  },
  openTask: "Open task {title}",
  cancelTask: "Cancel {title}",
  cancelTaskNotConfirmed: "Cancel of {title} was not confirmed; retry",
  cancelTaskAction: "Cancel task",
  canceling: "Canceling",
  runningMinutes: "{minutes} min",
  runningHours: "{hours} h",
  runningDays: "{days} d",
  // The Message a link pointed at, shown above the timeline.
  linkedSourceMessage: "Linked source Message",
  closeLinkedSourceMessage: "Close linked source Message",
  loadingSourceMessage: "Loading source Message…",
  sourceMessageUnavailable: "Source Message is unavailable.",
  // The Activity log.
  activityLog: "Activity log",
  showLessActivity: "Show less activity",
  showAllActivity: "Show all activity ({count} more)",
  showLess: "Show less",
  showMore: "Show more",
  preparedReply: "Prepared a reply",
  unconfirmed: "Unconfirmed",
  plan: "Plan",
  runPlan: "Run plan",
  inProgress: "In progress",
  stepDetails: "{title} details",
  outcome: "Outcome",
  outcomeCanceled: "Canceled",
  outcomeDeclined: "Declined",
  outcomeFailed: "Failed",
  outcomeSucceeded: "Succeeded",
  // A `teamhub task` step and the state of its Task.
  taskStarted: "Started",
  taskSentTo: "Sent to",
  taskStopped: "Stopped",
  tasksChecked: "Checked on tasks",
  taskRunning: "Task running",
  taskStatusRunning: "Running",
  taskStatusNeedsApproval: "Needs approval",
  taskStatusFinished: "Finished",
  taskStatusFailed: "Failed",
  taskStatusStopped: "Stopped",
  // The kinds of tool call.
  toolCommand: "Command",
  toolRead: "Read file",
  toolEdit: "Edit files",
  toolSearch: "Search",
  toolBrowser: "Web browsing",
  toolMessage: "Message",
  toolMessageRead: "Read messages",
  toolDelegation: "Agent collaboration",
  toolImage: "Image",
  toolInteraction: "User input",
  toolRecovery: "Recovery",
  toolReview: "Review",
  tool: "Tool",
  // What a step of each kind is doing, in the Activity log.
  summaryCommand: "Running a command",
  summaryRead: "Reviewing files",
  summaryEdit: "Updating files",
  summarySearch: "Searching for information",
  summaryBrowser: "Reviewing online information",
  summaryMessage: "Sending an update",
  summaryDelegation: "Coordinating with another agent",
  summaryTool: "Working on the task",
  readingMessages: "Reading messages",
  workingWithImages: "Working with images",
  recoveringTask: "Recovering the task",
  reviewingResults: "Reviewing the results",
  workingThroughSteps: {
    one: "Working through {count} step",
    other: "Working through {count} steps",
  },
  workingThroughTask: "Working through the task",
  // The status line's words for a step the Runtime does not describe.
  phraseRead: "Reading files",
  phraseEdit: "Editing files",
  phraseSearch: "Searching",
  phraseBrowser: "Browsing the web",
  phraseMessage: "Sending a message",
  phraseDelegation: "Working with another agent",
  phraseTool: "Using tools",
  // Why a Run failed, by the failure code the Computer or TeamHub reports.
  failureSessionNotFound:
    "Session history could not be restored. Check the local session and Local Computer compatibility before retrying.",
  failureProtocolIncompatible:
    "This Runtime protocol is incompatible with Local Computer. Update Local Computer or use a verified Runtime version.",
  failureAuthenticationRequired:
    "Runtime authentication failed. Sign in again or check your API credentials.",
  failureNetworkError:
    "The Runtime could not connect to the model service. Check your connection and service address.",
  failureRateLimited:
    "The model service rate limit or quota was reached. Check your quota before retrying.",
  failureModelUnavailable:
    "The model service does not offer the selected model to this Runtime's account. Choose another model for the Agent, or sign the Runtime in with an account that can use it.",
  failureModelNotOffered:
    "The Agent's Computer does not offer its selected model, or the model does not support its reasoning effort. Open the Agent's settings and choose a model and reasoning effort that the Computer offers.",
  failureLocalModelUnavailable:
    "The Agent's Computer could not load its local model. Open the Models page on that Computer: it may need more free memory, may not be fully downloaded, or may still be loading. Then try again, or choose another model for the Agent.",
  failureContextTooLong:
    "The conversation no longer fits the model's context window. Start a new chat with the Agent, or choose a model with a larger context window.",
  failureModelServiceError:
    "The model service reported an internal error. Try again in a moment; if it keeps failing, check the model provider's status.",
  failureTimeout:
    "The Runtime ran past its time limit without finishing. Try again, or split the request into smaller steps.",
  failureExecutionFailed:
    "The Runtime exited with an error it did not classify. Check Local Computer diagnostics before retrying.",
  failureExecutionOutcomeUnknown:
    "A command was dispatched, but its result could not be confirmed. It was not automatically replayed. Check its effects before retrying.",
  failureReplyUndelivered:
    "The Agent finished, but its reply did not reach the Room because every TeamHub message it tried to send failed. Check the Agent's connection to TeamHub, then ask again.",
  failureReplyNotSent:
    "The Agent finished without sending its reply to the Room. Its model may have answered without using the message command. Ask again, or choose a stronger model for the Agent.",
  failureInterrupted:
    "The Run stopped before it finished because its Computer restarted, for example to apply a system permission, or the Agent was stopped there. Part of its work may have taken effect; check the result before asking again.",
  failureComputerUnavailable:
    "The Agent's Computer could not run it. Make sure the Computer is online, the Agent is not stopped there, and its Runtime is enabled.",
  failureCleanupUnconfirmed:
    "The Runtime process could not be confirmed stopped. Check Local Computer before starting another Run.",
  failureResponseTooLarge:
    "The Agent's reply was larger than a Room message can hold. Ask for a shorter answer, or for the result as a file.",
  failureUnclassified:
    "The Run stopped because of an error the system could not identify. Try again; if it repeats, tell your administrator when it happened.",
});
