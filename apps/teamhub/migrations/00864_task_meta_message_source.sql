-- +goose Up
-- A Task input is a message from the Meta or a person, or a system notice, such as an
-- approval card's result; the Task conversation view shows them differently.
ALTER TABLE task_meta_messages
    ADD COLUMN source text NOT NULL DEFAULT 'message' CHECK (source IN ('message', 'system'));
ALTER TABLE task_meta_messages ALTER COLUMN source DROP DEFAULT;

-- +goose Down
ALTER TABLE task_meta_messages DROP COLUMN source;
