-- Migration: Cali Coffee Card (Prepaid Balance, Passcodes & 30-Day FIFO Expiration)

-- 1. Cali Customer Accounts / PIN Table
CREATE TABLE IF NOT EXISTS cali_credits (
    id SERIAL PRIMARY KEY,
    phone TEXT UNIQUE NOT NULL,
    pin_hash TEXT, -- 4-digit security passcode
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Cali Credit Transactions Ledger (FIFO with 30-Day Expiration)
CREATE TABLE IF NOT EXISTS cali_credit_transactions (
    id SERIAL PRIMARY KEY,
    phone TEXT NOT NULL,
    amount NUMERIC(10,2) NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('load', 'spend', 'expiration', 'bonus')),
    description TEXT,
    order_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ -- NULL for spend/expiration, NOW() + 30 days for load
);

CREATE INDEX IF NOT EXISTS idx_cali_credits_phone ON cali_credits(phone);
CREATE INDEX IF NOT EXISTS idx_cali_tx_phone ON cali_credit_transactions(phone);
CREATE INDEX IF NOT EXISTS idx_cali_tx_expires ON cali_credit_transactions(expires_at);
