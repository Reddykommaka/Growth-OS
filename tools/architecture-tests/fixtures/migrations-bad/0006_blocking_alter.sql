-- VIOLATION: NOT NULL column added with no default, and a type change.
ALTER TABLE listings ADD COLUMN seller_ref text NOT NULL;
ALTER TABLE orders ALTER COLUMN total_minor TYPE bigint;
