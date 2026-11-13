-- +goose Up
-- Memory now dates imported mail by its send time and names it by its
-- subject instead of the time and file name of the import. An indexed source
-- is rebuilt only when its text changes, so mail indexed before stays dated by
-- its import: drop it, with its versions, chunks and Session facts, and the
-- next sync indexes and extracts it again.
DELETE FROM memory_index.sources WHERE origin_kind = 'mail';

-- +goose Down
-- The dropped mail index is rebuilt by the next sync.
SELECT 1;
