-- VIOLATION: index built without CONCURRENTLY outside the initial migration.
CREATE INDEX listings_slug_idx ON listings (slug);
