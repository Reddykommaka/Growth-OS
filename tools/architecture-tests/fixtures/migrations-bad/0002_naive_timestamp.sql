-- VIOLATION: timestamp without time zone.
CREATE TABLE bad_ts (
  id         uuid PRIMARY KEY,
  created_at timestamp NOT NULL
);
