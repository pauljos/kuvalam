CREATE TABLE customers (
  customer_id VARCHAR(5) PRIMARY KEY,
  company_name VARCHAR(40) NOT NULL,
  contact_name VARCHAR(30),
  city VARCHAR(15),
  country VARCHAR(15)
);

CREATE TABLE orders (
  order_id SMALLINT PRIMARY KEY,
  customer_id VARCHAR(5) REFERENCES customers,
  employee_id SMALLINT,
  order_date DATE,
  ship_country VARCHAR(15)
);

CREATE TABLE order_details (
  order_id SMALLINT REFERENCES orders,
  product_id SMALLINT,
  unit_price REAL NOT NULL,
  quantity SMALLINT NOT NULL,
  discount REAL NOT NULL,
  PRIMARY KEY (order_id, product_id)
);

CREATE TABLE products (
  product_id SMALLINT PRIMARY KEY,
  product_name VARCHAR(40) NOT NULL,
  supplier_id SMALLINT,
  category_id SMALLINT,
  unit_price REAL,
  units_in_stock SMALLINT
);
