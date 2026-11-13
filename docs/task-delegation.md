# Task Delegation

An agent hands long work to background copies of itself and keeps talking with
you: the agent in your chat is its **Meta**, and each background copy, one per
Task, is an **AlterEgo**.

## In the chat

Tasks start when you ask, run side by side, and report back while the
conversation goes on.

![An animation of two Tasks running side by side: you ask Another Me to research Acme's rivals, then to draft a deck; its Meta starts a Task for each with task create, each AlterEgo's Task grows while it runs, a follow-up about the new logo joins the deck Task, and each result comes back into the chat as a card when its AlterEgo reports](../assets/feature-task-chat.gif)

| Moment                                                         | Task state                                   | Who wakes                                |
| -------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------- |
| An AlterEgo finishes a turn                                    | `idle`                                       | The Meta, with that turn's last reply    |
| A turn ends while an approval card waits in your chat          | `waiting_for_approval`                       | No one, until the card is answered       |
| You approve or deny the card, or it expires after 10 minutes   | `running`                                    | The AlterEgo                             |
| A turn fails                                                   | `failed`                                     | The Meta, with the error                 |
| You add to the request, while it runs or after it is done      | `running`, or queued behind the current turn | The AlterEgo                             |
| You ask how it is going                                        | Unchanged                                    | No one; the Meta reads the Task's status |
| You ask to stop it                                             | `canceled`, with its files and session kept  | No one                                   |
| You press Cancel on it under _tasks running in the background_ | `canceled`, with its files and session kept  | The Meta, told that you canceled it      |

<sub>A canceled Task is paused, not closed: the Meta can resume it with your
next request or do something else. A task a voice call started has no Meta, so
canceling it from the list cancels it the way the call does. An AlterEgo never
asks you anything; a question goes into its report, and the Meta decides
whether to ask.</sub>

Each `task` step in the Meta's activity is one line with the Task's name and
state. Open it, or a Task under _tasks running in the background_, to read the
Task like a chat: the brief and follow-ups the Meta sent, every step the
AlterEgo took with the command, file or search it acted on, and the approval
cards it raised. A card is answered there or in your chat, where it also
appears, and a running Task can be canceled from the same view. Steps are read
from the AlterEgo's session on your computer each time it takes a new one.

## On the computer

Each AlterEgo belongs to the Meta that started it: only the Meta talks with
you, and the AlterEgo's output lands in the Meta's own workspace.

![Inside one Room's Meta on your computer: only the Meta session exchanges messages with Rooms / Chat, it sends task create, send and stop to each AlterEgo and gets one report back, and the AlterEgo writes its output into the Meta's playground/<task-id>/](../assets/feature-task-computer.jpg)

|                       | Meta                           | AlterEgo                                      |
| --------------------- | ------------------------------ | --------------------------------------------- |
| How many              | One per Room                   | One per Task, up to 10 running per agent      |
| Woken by              | Your messages and Task reports | The Meta's brief, follow-ups and card results |
| Reads your chat       | Yes                            | No; the brief carries what it needs           |
| Talks to you          | Yes                            | No messages and no questions                  |
| Starts or stops Tasks | Only for its own Room          | No                                            |

<sub>Task commands and reports pass through the server. Each AlterEgo has its
own session and workspace on the same computer; only the Task folder is linked
into both. An AlterEgo can also read the folders of the other Tasks delegated
from the same Room, at the same `playground/<task-id>/` paths, so one Task's
output path works as-is in the next Task's brief. Its edits there are not
pre-approved the way edits in its own folder are.</sub>
