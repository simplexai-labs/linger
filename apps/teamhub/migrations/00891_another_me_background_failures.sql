-- +goose Up
-- Counts an Another Me's background model calls that failed in a row, with
-- the latest failure's reason code. A row exists only while the run lasts:
-- the next completed call deletes it.
CREATE TABLE public.another_me_background_failures (
    agent_actor_id text NOT NULL,
    tenant_id text NOT NULL,
    consecutive_failures integer NOT NULL,
    reason text NOT NULL,
    last_failed_at timestamp with time zone NOT NULL,
    CONSTRAINT another_me_background_failures_pkey PRIMARY KEY (agent_actor_id),
    CONSTRAINT another_me_background_failures_agent_actor_id_fkey FOREIGN KEY (agent_actor_id)
        REFERENCES public.agent_registrations(actor_id) ON DELETE CASCADE,
    CONSTRAINT another_me_background_failures_consecutive_failures_check CHECK ((consecutive_failures > 0))
);

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
    RAISE EXCEPTION 'another me background failures migration is forward-only';
END $$;
-- +goose StatementEnd
