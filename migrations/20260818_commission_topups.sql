-- ==============================================================================
-- QUIMIEATS COMMISSION TOPUPS & RECEIPT APPROVAL MIGRATION
-- Enables restaurants to upload bank transfer screenshots for admin verification
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.commission_topups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id TEXT NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
    amount NUMERIC(10, 2) NOT NULL,
    receipt_url TEXT NOT NULL,
    bank_name TEXT DEFAULT 'BAC Credomatic',
    reference_number TEXT,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    reviewed_at TIMESTAMP WITH TIME ZONE,
    reviewed_by TEXT
);

-- Index for speedy queries on pending receipts
CREATE INDEX IF NOT EXISTS idx_commission_topups_status ON public.commission_topups(status);
CREATE INDEX IF NOT EXISTS idx_commission_topups_res ON public.commission_topups(restaurant_id);

-- Enable RLS
ALTER TABLE public.commission_topups ENABLE ROW LEVEL SECURITY;

-- Allow public reads and inserts
CREATE POLICY "Allow public insert for commission_topups" 
ON public.commission_topups FOR INSERT TO public WITH CHECK (true);

CREATE POLICY "Allow public read for commission_topups" 
ON public.commission_topups FOR SELECT TO public USING (true);

CREATE POLICY "Allow public update for commission_topups" 
ON public.commission_topups FOR UPDATE TO public USING (true);
