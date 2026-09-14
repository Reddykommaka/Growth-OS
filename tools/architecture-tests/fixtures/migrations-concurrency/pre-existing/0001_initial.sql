-- Negative control, deliberately numbered 0001: the old rule exempted this file wholesale,
-- so a blocking build on a table it did NOT create slipped through. The generalised rule
-- catches it, because the exemption now follows the table rather than the filename.
CREATE INDEX established_table_name_idx ON established_table (name);
