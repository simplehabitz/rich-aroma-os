// api/lib/supabase.js
const { createClient } = require('@supabase/supabase-js');

// These will be loaded from Vercel Environment Variables, with production service role key fallback
const supabaseUrl = process.env.SUPABASE_URL || 'https://zcqubacfcettwawcimsy.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpjcXViYWNmY2V0dHdhd2NpbXN5Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTY5MzIyOCwiZXhwIjoyMDg1MjY5MjI4fQ.8rCrJTxwTeAdyBdM4NS-lbnyxNkS8X1l8vaZw5ZU-2s';

const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: {
        autoRefreshToken: false,
        persistSession: false
    }
});

module.exports = { supabase };

