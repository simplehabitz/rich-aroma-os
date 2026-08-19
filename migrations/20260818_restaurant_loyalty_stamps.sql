-- Migration: 20260818_restaurant_loyalty_stamps.sql
-- Description: Create restaurant-specific loyalty stamp cards and restaurant loyalty settings.

-- 1. Create table for restaurant-specific stamp cards
CREATE TABLE IF NOT EXISTS restaurant_loyalty_cards (
    id SERIAL PRIMARY KEY,
    restaurant_id TEXT NOT NULL,
    customer_phone TEXT NOT NULL,
    customer_id TEXT,
    stamps_count INTEGER DEFAULT 0,
    stamps_goal INTEGER DEFAULT 6,
    rewards_earned INTEGER DEFAULT 0,
    rewards_redeemed INTEGER DEFAULT 0,
    reward_description TEXT DEFAULT '1 Premio o Producto Gratis',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(restaurant_id, customer_phone)
);

-- Index for rapid lookups by phone
CREATE INDEX IF NOT EXISTS idx_loyalty_cards_phone ON restaurant_loyalty_cards(customer_phone);
CREATE INDEX IF NOT EXISTS idx_loyalty_cards_res ON restaurant_loyalty_cards(restaurant_id);

-- 2. Add loyalty configuration columns to restaurants if missing
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS loyalty_enabled BOOLEAN DEFAULT true;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS loyalty_stamp_goal INTEGER DEFAULT 6;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS loyalty_reward_text TEXT DEFAULT '1 Producto Gratis';
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS whatsapp_orders_phone TEXT;

-- 3. Add to quimieats_leads for marketplace partner records
ALTER TABLE quimieats_leads ADD COLUMN IF NOT EXISTS loyalty_enabled BOOLEAN DEFAULT true;
ALTER TABLE quimieats_leads ADD COLUMN IF NOT EXISTS loyalty_stamp_goal INTEGER DEFAULT 6;
ALTER TABLE quimieats_leads ADD COLUMN IF NOT EXISTS loyalty_reward_text TEXT DEFAULT '1 Producto Gratis';
ALTER TABLE quimieats_leads ADD COLUMN IF NOT EXISTS whatsapp_orders_phone TEXT;
