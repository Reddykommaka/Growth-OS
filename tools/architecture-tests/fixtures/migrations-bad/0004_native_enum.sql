-- VIOLATION: native enum type.
CREATE TYPE order_status AS ENUM ('pending', 'paid', 'shipped');
