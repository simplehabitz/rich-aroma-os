-- Create promos table for advertisement banners
CREATE TABLE IF NOT EXISTS promos (
    id TEXT PRIMARY KEY,
    client_name TEXT NOT NULL,
    media_url TEXT NOT NULL,
    start_date TIMESTAMPTZ NOT NULL,
    end_date TIMESTAMPTZ NOT NULL,
    active BOOLEAN DEFAULT true,
    impressions INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable Row Level Security (RLS)
ALTER TABLE promos ENABLE ROW LEVEL SECURITY;

-- Create policies
CREATE POLICY "Allow public select active" ON promos 
    FOR SELECT 
    USING (active = true);

CREATE POLICY "Allow admin all" ON promos 
    FOR ALL 
    USING (true);

-- Create RPC function to increment impression count
CREATE OR REPLACE FUNCTION increment_promo_impressions(target_id TEXT)
RETURNS VOID AS $$
BEGIN
    UPDATE promos
    SET impressions = COALESCE(impressions, 0) + 1
    WHERE id = target_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
