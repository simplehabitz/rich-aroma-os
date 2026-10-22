// api/lib/supabase.js
const { createClient } = require('@supabase/supabase-js');

// These will be loaded from Vercel Environment Variables, with production service role key fallback
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
if (!supabaseUrl || !supabaseKey) throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars');

const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: {
        autoRefreshToken: false,
        persistSession: false
    }
});

module.exports = { supabase };

