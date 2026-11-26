-- Baza "shop" za test:core (SQL Server). Naredbe su odvojene redovima GO.
CREATE TABLE dbo.customers (
  id int IDENTITY PRIMARY KEY,
  name nvarchar(100) NOT NULL,
  email nvarchar(200) UNIQUE,
  photo varbinary(100),
  balance decimal(10, 2) DEFAULT 0
)
GO
CREATE TABLE dbo.orders (
  id int IDENTITY PRIMARY KEY,
  customer_id int NOT NULL CONSTRAINT orders_customer_fk REFERENCES dbo.customers (id),
  total decimal(10, 2) NOT NULL DEFAULT 0,
  created_at datetime2 DEFAULT SYSDATETIME()
)
GO
CREATE INDEX orders_customer_idx ON dbo.orders (customer_id) INCLUDE (total)
GO
INSERT INTO dbo.customers (name, email, photo, balance) VALUES
  (N'Ana', N'ana@example.com', 0xDEADBEEF, 10.50),
  (N'Marko', N'marko@example.com', NULL, 99999999.99),
  (N'Iva', N'iva@example.com', NULL, 0)
GO
INSERT INTO dbo.orders (customer_id, total)
SELECT TOP 500 1 + n % 3, (n % 250) + 0.99
FROM (SELECT ROW_NUMBER() OVER (ORDER BY (SELECT 1)) AS n FROM sys.all_objects) x
GO
CREATE VIEW dbo.big_orders AS SELECT id, customer_id, total FROM dbo.orders WHERE total > 100
GO
CREATE FUNCTION dbo.order_total(@customer int, @min decimal(10, 2) = 0) RETURNS decimal(12, 2) AS
BEGIN
  RETURN (SELECT COALESCE(SUM(total), 0) FROM dbo.orders WHERE customer_id = @customer AND total >= @min)
END
GO
CREATE PROCEDURE dbo.cleanup @days int AS
BEGIN
  PRINT CONCAT('cleanup ', @days)
END
GO
CREATE TRIGGER dbo.orders_touch ON dbo.orders AFTER INSERT AS
BEGIN
  SET NOCOUNT ON
  UPDATE o SET created_at = SYSDATETIME() FROM dbo.orders o JOIN inserted i ON i.id = o.id
END
