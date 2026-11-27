-- +goose Up
-- What a phone wants to be told about: a finished reply, a decision it must
-- make, and whether to be told even while the Human is looking at the chat
-- on another device. IF NOT EXISTS: an earlier build of this branch recorded
-- this migration under 00899, 00901 or 00902.
ALTER TABLE paired_phones
    ADD COLUMN IF NOT EXISTS push_replies boolean NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS push_decisions boolean NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS push_when_active boolean NOT NULL DEFAULT false;

-- +goose Down
ALTER TABLE paired_phones
    DROP COLUMN push_replies,
    DROP COLUMN push_decisions,
    DROP COLUMN push_when_active;
