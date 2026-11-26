-- Baza "shop" za test:core (MariaDB). Naredbe su odvojene redovima GO.
CREATE TABLE customers (
  id int AUTO_INCREMENT PRIMARY KEY,
  name varchar(100) NOT NULL,
  email varchar(200) UNIQUE,
  photo varbinary(100),
  balance decimal(10, 2) DEFAULT 0
)
GO
CREATE TABLE orders (
  id int AUTO_INCREMENT PRIMARY KEY,
  customer_id int NOT NULL,
  total decimal(10, 2) NOT NULL DEFAULT 0,
  created_at datetime DEFAULT CURRENT_TIMESTAMP,
  KEY orders_customer_idx (customer_id),
  CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id) REFERENCES customers (id)
)
GO
INSERT INTO customers (name, email, photo, balance) VALUES
  ('Ana', 'ana@example.com', 0xDEADBEEF, 10.50),
  ('Marko', 'marko@example.com', NULL, 99999999.99),
  ('Iva', 'iva@example.com', NULL, 0)
GO
INSERT INTO orders (customer_id, total) SELECT 1 + seq % 3, (seq % 250) + 0.99 FROM seq_1_to_500
GO
CREATE VIEW big_orders AS SELECT id, customer_id, total FROM orders WHERE total > 100
GO
CREATE FUNCTION order_total(p_customer int) RETURNS decimal(12, 2) READS SQL DATA
  RETURN (SELECT COALESCE(SUM(total), 0) FROM orders WHERE customer_id = p_customer)
GO
CREATE PROCEDURE cleanup(IN p_days int)
BEGIN
  SELECT p_days AS days;
END
GO
CREATE TRIGGER orders_touch BEFORE INSERT ON orders FOR EACH ROW SET NEW.created_at = NOW()
