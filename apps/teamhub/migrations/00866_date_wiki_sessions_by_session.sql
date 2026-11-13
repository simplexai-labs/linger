-- +goose Up
-- Memory now dates a Session Wiki page by its Session's day
-- (sessions/<date>/<session>.md) instead of the day the Wiki was published,
-- so a time window finds the page for the day it is about. A source is
-- re-indexed only when its text changes, so set the date of the Session pages
-- already indexed once here.
UPDATE memory_index.source_versions version
SET manifest = jsonb_set(
    version.manifest,
    '{date}',
    to_jsonb(substring(source.metadata ->> 'page_key' FROM '^sessions/([0-9]{4}-[0-9]{2}-[0-9]{2})/'))
)
FROM memory_index.sources source
WHERE version.source_id = source.id
  AND source.origin_kind = 'wiki'
  AND source.metadata ->> 'page_key' ~ '^sessions/[0-9]{4}-[0-9]{2}-[0-9]{2}/[^/]+\.md$'
  AND source.metadata ->> 'page_key' !~ '/index\.md$';

-- +goose Down
-- Session pages keep their Session dates; the next Wiki publication writes them
-- the same way.
SELECT 1;
