-- +goose Up
-- A Capture whose recorder never saved audio can still finalize from its
-- complete live transcript; it then has no audio Document. Audio and its
-- Version stay set or unset together.
ALTER TABLE public.capture_sessions
    DROP CONSTRAINT capture_sessions_document_state_check,
    ADD CONSTRAINT capture_sessions_document_state_check CHECK (
        ((status <> 'finalized'::text) AND (document_id IS NULL) AND (document_version_id IS NULL))
        OR ((status = 'finalized'::text) AND ((document_id IS NULL) = (document_version_id IS NULL)))
    );

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
    RAISE EXCEPTION 'transcript-only captures migration is forward-only';
END $$;
-- +goose StatementEnd
