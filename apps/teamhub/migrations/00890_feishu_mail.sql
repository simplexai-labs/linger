-- +goose Up
-- AnotherMe may watch a Feishu Mail inbox like a Gmail or Outlook one. Feishu
-- Mail reads through its owner's own lark-cli on their Computer, so TeamHub
-- stores no Feishu credentials.
ALTER TABLE room_routine_listeners DROP CONSTRAINT room_routine_listeners_kind_check;
ALTER TABLE room_routine_listeners ADD CONSTRAINT room_routine_listeners_kind_check CHECK (
    kind = ANY (ARRAY['slack'::text, 'gmail'::text, 'outlook'::text, 'gcal'::text, 'outlook_calendar'::text, 'feishu_mail'::text])
);

-- +goose Down
DELETE FROM room_routine_listeners WHERE kind = 'feishu_mail';
ALTER TABLE room_routine_listeners DROP CONSTRAINT room_routine_listeners_kind_check;
ALTER TABLE room_routine_listeners ADD CONSTRAINT room_routine_listeners_kind_check CHECK (
    kind = ANY (ARRAY['slack'::text, 'gmail'::text, 'outlook'::text, 'gcal'::text, 'outlook_calendar'::text])
);
