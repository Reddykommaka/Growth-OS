-- VIOLATION: foreign key with no covering index.
CREATE TABLE child_rows (
  id        uuid PRIMARY KEY,
  parent_id uuid NOT NULL REFERENCES parents (id)
);
