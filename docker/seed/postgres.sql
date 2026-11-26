-- Baza "shop" za test:core (PostgreSQL). Naredbe su odvojene redovima GO.
CREATE SCHEMA sales
GO
CREATE TABLE sales.customers (
  id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  email text UNIQUE,
  photo bytea,
  balance numeric(10, 2) DEFAULT 0
)
GO
CREATE TABLE sales.orders (
  id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id int NOT NULL CONSTRAINT orders_customer_fk REFERENCES sales.customers (id),
  total numeric(10, 2) NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
)
GO
CREATE INDEX orders_customer_idx ON sales.orders (customer_id) INCLUDE (total)
GO
INSERT INTO sales.customers (name, email, photo, balance) VALUES
  ('Ana', 'ana@example.com', '\xdeadbeef', 10.50),
  ('Marko', 'marko@example.com', NULL, 99999999.99),
  ('Iva', 'iva@example.com', NULL, 0)
GO
INSERT INTO sales.orders (customer_id, total)
SELECT 1 + g % 3, (g % 250) + 0.99 FROM generate_series(1, 500) g
GO
CREATE VIEW sales.big_orders AS SELECT id, customer_id, total FROM sales.orders WHERE total > 100
GO
CREATE FUNCTION sales.order_total(p_customer int, p_min numeric DEFAULT 0) RETURNS numeric
LANGUAGE sql AS $$ SELECT COALESCE(SUM(total), 0) FROM sales.orders WHERE customer_id = p_customer AND total >= p_min $$
GO
CREATE PROCEDURE sales.cleanup(p_days int) LANGUAGE plpgsql AS $$
BEGIN
  RAISE NOTICE 'cleanup %', p_days;
END
$$
GO
CREATE FUNCTION sales.touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.created_at := now();
  RETURN NEW;
END
$$
GO
CREATE TRIGGER orders_touch BEFORE INSERT ON sales.orders FOR EACH ROW EXECUTE FUNCTION sales.touch()
