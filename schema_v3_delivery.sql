-- Add delivery support to orders
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_address TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_status TEXT DEFAULT 'pending'; -- pending, assigned, out_for_delivery, delivered
ALTER TABLE orders ADD COLUMN IF NOT EXISTS driver_id TEXT REFERENCES employees(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfillment_type TEXT DEFAULT 'pickup'; -- pickup, dinein, delivery
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_pin TEXT;

