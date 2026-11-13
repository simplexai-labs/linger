-- +goose Up
-- The latest model library each Local Computer reported, so an offline
-- Computer still shows what it last reported. host is the last host any
-- snapshot carried, kept when a later one (an unavailable library) has none.
-- A removed Computer's row is deleted in the transaction that removes it; the
-- foreign key covers a Computer row that is deleted outright.
CREATE TABLE local_computer_model_snapshots (
    computer_id text PRIMARY KEY REFERENCES local_computers(computer_id) ON DELETE CASCADE,
    snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
    host jsonb CHECK (host IS NULL OR jsonb_typeof(host) = 'object'),
    observed_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- +goose Down
DROP TABLE local_computer_model_snapshots;
