-- VIOLATION: money stored as a floating-point / numeric type.
CREATE TABLE bad_money (
  id           uuid PRIMARY KEY,
  total_amount numeric(12,2) NOT NULL,
  unit_price   double precision NOT NULL
);
