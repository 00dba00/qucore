-- Demo baza "demo" (MariaDB) za snimke vodiča: izmišljena web trgovina.
-- Svi podaci su generirani (imena, e-mailovi @example.com, telefoni, iznosi); nema stvarnih osoba ni tvrtki.
-- Datumi su relativni na trenutak seeda, pa "zadnjih 7 dana" uvijek ima podataka. Naredbe su odvojene redovima GO.
CREATE TABLE regions (
  id tinyint PRIMARY KEY,
  name varchar(40) NOT NULL,
  country char(2) NOT NULL DEFAULT 'HR'
)
GO
INSERT INTO regions (id, name) VALUES
  (1, 'Zagreb'), (2, 'Split'), (3, 'Rijeka'), (4, 'Osijek'), (5, 'Zadar'), (6, 'Pula'), (7, 'Varaždin'), (8, 'Dubrovnik')
GO
CREATE TABLE customers (
  id int AUTO_INCREMENT PRIMARY KEY,
  first_name varchar(50) NOT NULL,
  last_name varchar(50) NOT NULL,
  email varchar(120) NOT NULL UNIQUE,
  phone varchar(30),
  region_id tinyint NOT NULL,
  segment enum('retail', 'business', 'vip') NOT NULL DEFAULT 'retail',
  newsletter boolean NOT NULL DEFAULT false,
  created_at datetime NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  KEY customers_region_idx (region_id),
  KEY customers_last_name_idx (last_name, first_name),
  CONSTRAINT customers_region_fk FOREIGN KEY (region_id) REFERENCES regions (id)
)
GO
INSERT INTO customers (first_name, last_name, email, phone, region_id, segment, newsletter, created_at, is_active)
SELECT fn, ln,
  LOWER(CONCAT(fa, '.', la, seq, '@example.com')),
  CONCAT('+385 9', 1 + seq % 9, ' ', LPAD((seq * 7919) % 1000, 3, '0'), ' ', LPAD((seq * 104729) % 10000, 4, '0')),
  1 + (seq * 13) % 8,
  CASE WHEN seq % 23 = 0 THEN 'vip' WHEN seq % 5 = 0 THEN 'business' ELSE 'retail' END,
  seq % 3 = 0,
  NOW() - INTERVAL (900 - (seq * 3) % 890) DAY - INTERVAL (seq * 37) % 1440 MINUTE,
  seq % 29 <> 0
FROM (
  SELECT seq,
    ELT(1 + seq % 24, 'Ana', 'Ivan', 'Marija', 'Luka', 'Petra', 'Marko', 'Ivana', 'Josip', 'Lucija', 'Tomislav', 'Katarina', 'Filip',
      'Maja', 'Matej', 'Sara', 'Nikola', 'Lana', 'Ante', 'Ema', 'David', 'Mia', 'Karlo', 'Nika', 'Dario') AS fn,
    ELT(1 + seq % 24, 'ana', 'ivan', 'marija', 'luka', 'petra', 'marko', 'ivana', 'josip', 'lucija', 'tomislav', 'katarina', 'filip',
      'maja', 'matej', 'sara', 'nikola', 'lana', 'ante', 'ema', 'david', 'mia', 'karlo', 'nika', 'dario') AS fa,
    ELT(1 + (seq * 7) % 26, 'Horvat', 'Kovačević', 'Babić', 'Marić', 'Jurić', 'Novak', 'Kovačić', 'Knežević', 'Vuković', 'Marković',
      'Petrović', 'Matić', 'Tomić', 'Pavlović', 'Kovač', 'Božić', 'Blažević', 'Grgić', 'Pavić', 'Radić', 'Perić', 'Šarić',
      'Lovrić', 'Vidović', 'Perković', 'Mandić') AS ln,
    ELT(1 + (seq * 7) % 26, 'horvat', 'kovacevic', 'babic', 'maric', 'juric', 'novak', 'kovacic', 'knezevic', 'vukovic', 'markovic',
      'petrovic', 'matic', 'tomic', 'pavlovic', 'kovac', 'bozic', 'blazevic', 'grgic', 'pavic', 'radic', 'peric', 'saric',
      'lovric', 'vidovic', 'perkovic', 'mandic') AS la
  FROM seq_1_to_400
) n
GO
CREATE TABLE categories (
  id smallint PRIMARY KEY,
  name varchar(60) NOT NULL,
  parent_id smallint NULL,
  CONSTRAINT categories_parent_fk FOREIGN KEY (parent_id) REFERENCES categories (id)
)
GO
INSERT INTO categories (id, name, parent_id) VALUES
  (1, 'Electronics', NULL), (2, 'Home & Kitchen', NULL), (3, 'Sports & Outdoors', NULL), (4, 'Books', NULL),
  (5, 'Laptops', 1), (6, 'Phones', 1), (7, 'Audio', 1), (8, 'Cookware', 2), (9, 'Furniture', 2), (10, 'Cycling', 3),
  (11, 'Camping', 3), (12, 'Fiction', 4), (13, 'Technical', 4)
GO
CREATE TABLE suppliers (
  id smallint AUTO_INCREMENT PRIMARY KEY,
  name varchar(80) NOT NULL,
  country char(2) NOT NULL,
  contact_email varchar(120),
  rating decimal(2, 1)
)
GO
INSERT INTO suppliers (name, country, contact_email, rating) VALUES
  ('Adriatic Trade d.o.o.', 'HR', 'sales@adriatic-trade.example', 4.6),
  ('Nordlicht GmbH', 'DE', 'orders@nordlicht.example', 4.2),
  ('Vista Components', 'IT', 'info@vista-components.example', 3.9),
  ('Panonija Distribucija', 'HR', 'nabava@panonija.example', 4.4),
  ('Alpen Outdoor AG', 'AT', 'b2b@alpen-outdoor.example', 4.8),
  ('Danube Books', 'HU', 'trade@danube-books.example', 4.1),
  ('Kvarner Home', 'HR', 'prodaja@kvarner-home.example', 3.7),
  ('Silicon Bay Ltd', 'IE', 'eu@siliconbay.example', 4.5)
GO
CREATE TABLE products (
  id int AUTO_INCREMENT PRIMARY KEY,
  sku varchar(20) NOT NULL UNIQUE,
  name varchar(120) NOT NULL,
  category_id smallint NOT NULL,
  supplier_id smallint NOT NULL,
  price decimal(10, 2) NOT NULL,
  cost decimal(10, 2) NOT NULL,
  stock int NOT NULL DEFAULT 0,
  is_discontinued boolean NOT NULL DEFAULT false,
  created_at datetime NOT NULL,
  KEY products_category_idx (category_id),
  KEY products_supplier_idx (supplier_id),
  CONSTRAINT products_category_fk FOREIGN KEY (category_id) REFERENCES categories (id),
  CONSTRAINT products_supplier_fk FOREIGN KEY (supplier_id) REFERENCES suppliers (id)
)
GO
INSERT INTO products (sku, name, category_id, supplier_id, price, cost, stock, is_discontinued, created_at)
SELECT CONCAT(ELT(cat - 4, 'LAP', 'PHN', 'AUD', 'CKW', 'FUR', 'CYC', 'CMP', 'FIC', 'TEC'), '-', LPAD(seq, 4, '0')),
  CONCAT(ELT(1 + seq % 6, 'Nova', 'Pro', 'Classic', 'Lite', 'Max', 'Eco'), ' ',
    CASE cat
      WHEN 5 THEN ELT(1 + (seq DIV 9) % 4, 'Laptop 14"', 'Laptop 15.6"', 'Ultrabook 13"', 'Workstation 16"')
      WHEN 6 THEN ELT(1 + (seq DIV 9) % 4, 'Smartphone 128 GB', 'Smartphone 256 GB', 'Phone Case', 'USB-C Charger 65 W')
      WHEN 7 THEN ELT(1 + (seq DIV 9) % 4, 'Wireless Headphones', 'Bluetooth Speaker', 'Earbuds', 'Soundbar')
      WHEN 8 THEN ELT(1 + (seq DIV 9) % 4, 'Frying Pan 28 cm', 'Cooking Pot 5 L', 'Knife Set', 'Baking Tray')
      WHEN 9 THEN ELT(1 + (seq DIV 9) % 4, 'Office Chair', 'Bookshelf', 'Desk 140 cm', 'Side Table')
      WHEN 10 THEN ELT(1 + (seq DIV 9) % 4, 'Bike Helmet', 'Bike Lights Set', 'Cycling Gloves', 'Water Bottle 750 ml')
      WHEN 11 THEN ELT(1 + (seq DIV 9) % 4, 'Tent 2P', 'Sleeping Bag', 'Camping Stove', 'Headlamp')
      WHEN 12 THEN ELT(1 + (seq DIV 9) % 4, 'Novel (Paperback)', 'Short Stories', 'Crime Novel', 'Poetry Collection')
      ELSE ELT(1 + (seq DIV 9) % 4, 'SQL Performance Guide', 'Data Modeling Basics', 'Practical Statistics', 'Network Handbook')
    END),
  cat,
  CASE WHEN cat IN (5, 6, 7) THEN ELT(1 + seq % 3, 2, 3, 8) WHEN cat IN (8, 9) THEN ELT(1 + seq % 2, 4, 7)
       WHEN cat IN (10, 11) THEN ELT(1 + seq % 2, 1, 5) ELSE 6 END,
  price, ROUND(price * (0.55 + (seq % 20) / 100), 2),
  (seq * 37) % 180,
  seq % 31 = 0,
  NOW() - INTERVAL (1000 - (seq * 7) % 990) DAY
FROM (
  SELECT seq, 5 + seq % 9 AS cat,
    ROUND(CASE 5 + seq % 9
      WHEN 5 THEN 650 + (seq * 53) % 1400 WHEN 6 THEN 15 + (seq * 41) % 900 WHEN 7 THEN 25 + (seq * 29) % 320
      WHEN 8 THEN 12 + (seq * 17) % 140 WHEN 9 THEN 45 + (seq * 61) % 520 WHEN 10 THEN 9 + (seq * 13) % 120
      WHEN 11 THEN 14 + (seq * 23) % 380 ELSE 9 + (seq * 7) % 45 END + 0.99, 2) AS price
  FROM seq_1_to_180
) p
GO
CREATE TABLE employees (
  id smallint AUTO_INCREMENT PRIMARY KEY,
  first_name varchar(50) NOT NULL,
  last_name varchar(50) NOT NULL,
  title varchar(60) NOT NULL,
  manager_id smallint NULL,
  email varchar(120) NOT NULL UNIQUE,
  hired_at date NOT NULL,
  CONSTRAINT employees_manager_fk FOREIGN KEY (manager_id) REFERENCES employees (id)
)
GO
INSERT INTO employees (first_name, last_name, title, manager_id, email, hired_at) VALUES
  ('Helena', 'Barić', 'Managing Director', NULL, 'helena.baric@demo-shop.example', '2017-03-01'),
  ('Krešimir', 'Lončar', 'Head of Sales', 1, 'kresimir.loncar@demo-shop.example', '2018-01-15'),
  ('Tena', 'Rukavina', 'Head of Operations', 1, 'tena.rukavina@demo-shop.example', '2018-06-01'),
  ('Bruno', 'Sertić', 'Data Analyst', 1, 'bruno.sertic@demo-shop.example', '2021-09-13'),
  ('Iva', 'Mlinar', 'Sales Representative', 2, 'iva.mlinar@demo-shop.example', '2019-04-08'),
  ('Domagoj', 'Kralj', 'Sales Representative', 2, 'domagoj.kralj@demo-shop.example', '2020-02-03'),
  ('Martina', 'Šimić', 'Key Account Manager', 2, 'martina.simic@demo-shop.example', '2019-11-18'),
  ('Zoran', 'Vlahović', 'Warehouse Lead', 3, 'zoran.vlahovic@demo-shop.example', '2018-09-24'),
  ('Paula', 'Đurić', 'Customer Support', 3, 'paula.djuric@demo-shop.example', '2022-05-02'),
  ('Hrvoje', 'Bašić', 'Customer Support', 3, 'hrvoje.basic@demo-shop.example', '2023-01-09'),
  ('Lea', 'Golub', 'Logistics Coordinator', 3, 'lea.golub@demo-shop.example', '2021-03-15'),
  ('Antonio', 'Bilić', 'Junior Analyst', 4, 'antonio.bilic@demo-shop.example', '2024-10-01')
GO
CREATE TABLE orders (
  id int AUTO_INCREMENT PRIMARY KEY,
  customer_id int NOT NULL,
  order_date datetime NOT NULL,
  status enum('new', 'paid', 'shipped', 'delivered', 'cancelled', 'returned') NOT NULL,
  channel enum('web', 'mobile', 'store') NOT NULL,
  sales_rep_id smallint NULL,
  shipping_region_id tinyint NOT NULL,
  total decimal(12, 2) NOT NULL DEFAULT 0,
  updated_at datetime NULL,
  KEY orders_customer_idx (customer_id),
  KEY orders_date_idx (order_date),
  KEY orders_status_idx (status, order_date),
  CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id) REFERENCES customers (id),
  CONSTRAINT orders_rep_fk FOREIGN KEY (sales_rep_id) REFERENCES employees (id),
  CONSTRAINT orders_region_fk FOREIGN KEY (shipping_region_id) REFERENCES regions (id)
)
GO
INSERT INTO orders (customer_id, order_date, status, channel, sales_rep_id, shipping_region_id)
SELECT c, d,
  CASE
    WHEN d > NOW() - INTERVAL 2 DAY THEN ELT(1 + seq % 2, 'new', 'paid')
    WHEN d > NOW() - INTERVAL 6 DAY THEN ELT(1 + seq % 3, 'paid', 'shipped', 'shipped')
    WHEN seq % 41 = 0 THEN 'cancelled'
    WHEN seq % 53 = 0 THEN 'returned'
    ELSE 'delivered'
  END,
  ELT(1 + (seq * 3) % 10, 'web', 'web', 'web', 'web', 'mobile', 'mobile', 'mobile', 'store', 'store', 'web'),
  CASE WHEN seq % 4 = 0 THEN ELT(1 + seq % 3, 5, 6, 7) END,
  1 + (c * 13) % 8
FROM (
  SELECT seq, 1 + (seq * 7919) % 400 AS c,
    NOW() - INTERVAL POW((seq * 104729 % 10007) / 10007, 1.6) * 540 * 24 * 60 MINUTE AS d
  FROM seq_1_to_6000
) o
GO
CREATE TABLE order_items (
  order_id int NOT NULL,
  line_no tinyint NOT NULL,
  product_id int NOT NULL,
  quantity smallint NOT NULL,
  unit_price decimal(10, 2) NOT NULL,
  discount_pct decimal(4, 1) NOT NULL DEFAULT 0,
  PRIMARY KEY (order_id, line_no),
  KEY order_items_product_idx (product_id),
  CONSTRAINT order_items_order_fk FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE,
  CONSTRAINT order_items_product_fk FOREIGN KEY (product_id) REFERENCES products (id)
)
GO
INSERT INTO order_items (order_id, line_no, product_id, quantity, unit_price, discount_pct)
SELECT o.id, l.seq, p.id, 1 + (o.id + l.seq) % 3 * ((o.id * l.seq) % 4 = 0), p.price,
  CASE WHEN (o.id * 7 + l.seq) % 11 = 0 THEN 10 WHEN (o.id + l.seq) % 17 = 0 THEN 25 ELSE 0 END
FROM orders o
JOIN seq_1_to_5 l ON l.seq <= 1 + (o.id * 31) % 4 + (o.id % 13 = 0)
JOIN products p ON p.id = 1 + (o.id * 53 + l.seq * 97) % 180
GO
UPDATE orders o
JOIN (SELECT order_id, SUM(quantity * unit_price * (1 - discount_pct / 100)) AS s FROM order_items GROUP BY order_id) t ON t.order_id = o.id
SET o.total = ROUND(t.s, 2)
GO
CREATE TABLE payments (
  id int AUTO_INCREMENT PRIMARY KEY,
  order_id int NOT NULL,
  paid_at datetime NOT NULL,
  method enum('card', 'paypal', 'bank_transfer', 'cash_on_delivery') NOT NULL,
  amount decimal(12, 2) NOT NULL,
  status enum('authorized', 'captured', 'refunded', 'failed') NOT NULL,
  reference varchar(40) NOT NULL,
  KEY payments_order_idx (order_id),
  CONSTRAINT payments_order_fk FOREIGN KEY (order_id) REFERENCES orders (id)
)
GO
INSERT INTO payments (order_id, paid_at, method, amount, status, reference)
SELECT id, order_date + INTERVAL (id % 90) MINUTE,
  ELT(1 + (id * 7) % 10, 'card', 'card', 'card', 'card', 'paypal', 'paypal', 'bank_transfer', 'cash_on_delivery', 'card', 'paypal'),
  total,
  CASE status WHEN 'returned' THEN 'refunded' WHEN 'paid' THEN 'authorized' ELSE 'captured' END,
  CONCAT('PAY-', UPPER(SUBSTRING(MD5(id), 1, 10)))
FROM orders
WHERE status NOT IN ('new', 'cancelled')
GO
INSERT INTO payments (order_id, paid_at, method, amount, status, reference)
SELECT id, order_date + INTERVAL 3 MINUTE, 'card', total, 'failed', CONCAT('PAY-', UPPER(SUBSTRING(MD5(id + 1), 1, 10)))
FROM orders
WHERE id % 37 = 0
GO
CREATE TABLE reviews (
  id int AUTO_INCREMENT PRIMARY KEY,
  product_id int NOT NULL,
  customer_id int NOT NULL,
  rating tinyint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title varchar(120),
  body text,
  created_at datetime NOT NULL,
  KEY reviews_product_idx (product_id),
  CONSTRAINT reviews_product_fk FOREIGN KEY (product_id) REFERENCES products (id),
  CONSTRAINT reviews_customer_fk FOREIGN KEY (customer_id) REFERENCES customers (id)
)
GO
INSERT INTO reviews (product_id, customer_id, rating, title, body, created_at)
SELECT i.product_id, o.customer_id, r,
  ELT(r, 'Disappointed', 'Not great', 'It is okay', 'Very good', 'Excellent!'),
  ELT(r, 'Stopped working after a week, returned it.', 'Does the job but feels cheap.', 'Average quality for the price.',
    'Good value, fast delivery.', 'Exactly as described, would buy again.'),
  o.order_date + INTERVAL 5 + o.id % 20 DAY
FROM (SELECT order_id, product_id, ELT(1 + CRC32(CONCAT(order_id, '-', line_no)) % 20, 5, 5, 4, 5, 5, 4, 5, 3, 4, 5, 4, 5, 2, 4, 5, 3, 5, 4, 1, 5) AS r FROM order_items WHERE (order_id + line_no) % 6 = 0) i
JOIN orders o ON o.id = i.order_id AND o.status = 'delivered'
GO
CREATE VIEW v_monthly_revenue AS
SELECT DATE_FORMAT(order_date, '%Y-%m') AS month, COUNT(*) AS orders, SUM(total) AS revenue, ROUND(AVG(total), 2) AS avg_order
FROM orders
WHERE status NOT IN ('cancelled', 'returned')
GROUP BY DATE_FORMAT(order_date, '%Y-%m')
GO
CREATE VIEW v_customer_summary AS
SELECT c.id, CONCAT(c.first_name, ' ', c.last_name) AS customer, c.segment, r.name AS region,
  COUNT(o.id) AS orders, COALESCE(SUM(o.total), 0) AS lifetime_value, MAX(o.order_date) AS last_order
FROM customers c
JOIN regions r ON r.id = c.region_id
LEFT JOIN orders o ON o.customer_id = c.id AND o.status NOT IN ('cancelled', 'returned')
GROUP BY c.id, c.first_name, c.last_name, c.segment, r.name
GO
CREATE VIEW v_low_stock AS
SELECT p.sku, p.name, c.name AS category, s.name AS supplier, p.stock
FROM products p
JOIN categories c ON c.id = p.category_id
JOIN suppliers s ON s.id = p.supplier_id
WHERE p.stock < 15 AND NOT p.is_discontinued
GO
CREATE FUNCTION customer_lifetime_value(p_customer int) RETURNS decimal(12, 2) READS SQL DATA
  RETURN (SELECT COALESCE(SUM(total), 0) FROM orders WHERE customer_id = p_customer AND status NOT IN ('cancelled', 'returned'))
GO
CREATE PROCEDURE cancel_stale_orders(IN p_days int)
BEGIN
  UPDATE orders SET status = 'cancelled' WHERE status = 'new' AND order_date < NOW() - INTERVAL p_days DAY;
  SELECT ROW_COUNT() AS cancelled_orders;
END
GO
CREATE TRIGGER orders_touch BEFORE UPDATE ON orders FOR EACH ROW SET NEW.updated_at = NOW()
GO
ANALYZE TABLE customers, products, orders, order_items, payments, reviews
