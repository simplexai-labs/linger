# Target: gmail

A gmail canvas is for a new email only. To answer an email someone sent, use
`teamhub gmail reply` instead; a canvas draft does not join that thread.

Fields in the canvas header:

- `to`: recipient emails, separated by commas only (never semicolons).
- `cc`: carbon-copy emails, separated by commas only; may be empty.
- `subject`: one line.

The email body is everything after the header block. Images in the canvas go
into the email body as inline images, exactly as they appear in the canvas.
File blocks in the canvas go as attachments, under their file names; their
lines do not appear in the body. Attach files only through the canvas: never
use `teamhub gmail send --attach` or `teamhub gmail draft --attach` for a
canvas email, since the draft and the email are rebuilt from the canvas.

## Send

The canvas card in the chat has a Send button. Editing the canvas only saves
it in Linger; when the user clicks Send, Linger uploads the canvas, its inline
images and attachments included, to Gmail and sends it exactly as the user
sees it, then marks the header `status: sent`.

- Do not save a Gmail draft and do not send a canvas email yourself: no
  `teamhub gmail canvas-draft`, `teamhub gmail draft` or `teamhub gmail send`
  for it.
- When the canvas is ready, or the user asks you to send it, tell them in one
  short sentence to review it and click Send on the email card.
- Never set `status`, `link` or `external_id` yourself.

Images must stay under 5 MiB in total; shrink large ones first (see Images in
`SKILL.md`). Attachments must stay under 15 MiB in total; for larger
files, share a link in the body instead.

## Gmail not connected or not sent

If Gmail is not connected, the card says so and Send stays off; tell the user
to connect Gmail in Connected apps. If the card says the email was not sent or
asks to check Gmail, do not resend it yourself; tell the user what the card
says.
