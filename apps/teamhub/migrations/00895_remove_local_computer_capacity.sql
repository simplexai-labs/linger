-- +goose Up
ALTER TABLE local_computers DROP COLUMN capacity;

-- +goose Down
ALTER TABLE local_computers ADD COLUMN capacity integer CHECK (capacity >= 0);
