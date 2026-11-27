-- +goose Up
-- An Agent Message sent with --continuing only says the Agent is still
-- working. The Room reply guard must not count it as the reply, including in
-- a Run that has no status Room to record a presentation output event.
ALTER TABLE public.messages
    ADD COLUMN continues boolean DEFAULT false NOT NULL;

-- +goose Down
ALTER TABLE public.messages
    DROP COLUMN continues;
