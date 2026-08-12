-- Rich Aroma OS v2.0 Database Schema
-- "The Bank-Grade Coffee Shop"

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. USERS & AUTH (The Identity)
-- Phone number is the primary key for speed/simplicity.
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    phone TEXT UNIQUE NOT NULL, -- Format: 50499999999
    name TEXT,
    pin_hash TEXT, -- Encrypted 4-digit PIN
    is_member BOOLEAN DEFAULT FALSE,
    member_since TIMESTAMP WITH TIME ZONE,
    membership_expiry TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_visit TIMESTAMP WITH TIME ZONE,
    total_spend_ltv DECIMAL(10,2) DEFAULT 0.00
);

-- 2. WALLETS (The Money)
-- Separation of "Real Cash" vs "Bonus Cash" for expiry rules.
CREATE TABLE wallets (
    user_id UUID PRIMARY KEY REFERENCES users(id),
    cash_balance DECIMAL(10,2) DEFAULT 0.00, -- Real money (Never expires)
    bonus_balance DECIMAL(10,2) DEFAULT 0.00, -- Bonus money (Expires)
    points_balance INTEGER DEFAULT 0, -- Loyalty points
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. TRANSACTIONS (The Ledger)
-- Immutable record of every money movement.
CREATE TYPE transaction_type AS ENUM ('DEPOSIT', 'PURCHASE', 'BONUS', 'REFUND', 'TRANSFER', 'MEMBERSHIP_FEE');

CREATE TABLE transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id),
    amount DECIMAL(10,2) NOT NULL,
    type transaction_type NOT NULL,
    description TEXT,
    reference_id TEXT, -- e.g., Order ID or Transfer Ref
    balance_after DECIMAL(10,2), -- Snapshot for audit
    created_by UUID REFERENCES users(id), -- Staff ID who authorized it
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. MEMBERSHIPS (The Subscriptions)
CREATE TABLE memberships (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id),
    start_date TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    end_date TIMESTAMP WITH TIME ZONE,
    price_paid DECIMAL(10,2),
    status TEXT DEFAULT 'ACTIVE', -- ACTIVE, EXPIRED, CANCELLED
    daily_coffee_token_used BOOLEAN DEFAULT FALSE,
    last_token_reset TIMESTAMP WITH TIME ZONE
);

-- 5. MENU & INVENTORY (The Product)
CREATE TABLE menu_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    description TEXT,
    price DECIMAL(10,2) NOT NULL,
    category TEXT NOT NULL, -- Drinks, Food, Merchandise
    image_url TEXT,
    is_secret BOOLEAN DEFAULT FALSE, -- Secret Menu items
    is_available BOOLEAN DEFAULT TRUE,
    is_bundle BOOLEAN DEFAULT FALSE, -- Combo bundle items
    prep_station TEXT DEFAULT 'KITCHEN' -- KITCHEN or BAR
);

-- 6. ORDERS (The Activity)
CREATE TYPE order_status AS ENUM ('PENDING', 'PAID', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED');

CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    short_id TEXT, -- e.g., "4242" for cashier lookup
    user_id UUID REFERENCES users(id),
    status order_status DEFAULT 'PENDING',
    total_amount DECIMAL(10,2) NOT NULL,
    payment_method TEXT, -- RICO_CASH, CASH, TRANSFER
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE order_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID REFERENCES orders(id),
    menu_item_id UUID REFERENCES menu_items(id),
    quantity INTEGER NOT NULL,
    price_at_time DECIMAL(10,2) NOT NULL, -- Snapshotted price
    modifiers JSONB, -- e.g., {"milk": "oat", "sugar": "none"}
    bundle_selections JSONB -- e.g., [{"slot_name": "Bebida", "item_id": "UUID", "upcharge": 0.00}]
);

-- 7. BUNDLE SLOTS (The Combos)
CREATE TABLE bundle_slots (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    parent_item_id UUID REFERENCES menu_items(id) ON DELETE CASCADE,
    slot_name TEXT NOT NULL, -- e.g., "Bebida", "Acompañamiento"
    allowed_category TEXT NOT NULL, -- e.g., "Drinks", "Sides"
    upcharge DECIMAL(10,2) DEFAULT 0.00
);

-- 8. GIFTS (The Viral Loop)
CREATE TABLE gifts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sender_id UUID REFERENCES users(id),
    recipient_phone TEXT NOT NULL,
    amount DECIMAL(10,2) DEFAULT 0, -- Or specific item ID
    message TEXT,
    claimed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- INDEXES for Speed
CREATE INDEX idx_users_phone ON users(phone);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_transactions_user ON transactions(user_id);
