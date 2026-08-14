const { supabase } = require('./lib/supabase');

module.exports = async function handler(req, res) {
    try {
        let { action, id } = req.query;
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (req.method === 'OPTIONS') return res.status(200).end();

        // PUBLIC ACTIONS
        if (action === 'active' && req.method === 'GET') {
            const now = new Date().toISOString();
            const { data, error } = await supabase
                .from('promos')
                .select('*')
                .eq('active', true)
                .lte('start_date', now)
                .gte('end_date', now)
                .order('created_at', { ascending: false });
            
            if (error) {
                console.warn("[Promos API] Database table error, using demo fallback:", error.message);
                // Return default demo banner to prevent breaking the customer app UI
                return res.json([
                    {
                        id: "demo_promo_1",
                        client_name: "Rich Aroma Coffee Shop",
                        media_url: "https://zcqubacfcettwawcimsy.supabase.co/storage/v1/object/public/menu-images/uploads/1780064113444_Copy_of_Copy_of_Menu_2025_-_2_512_x_512_px.png",
                        start_date: now,
                        end_date: now,
                        active: true,
                        impressions: 0
                    }
                ]);
            }
            return res.json(data || []);
        }

        if (action === 'track_impression' && req.method === 'POST') {
            const { promo_id } = req.body;
            if (!promo_id) return res.status(400).json({ error: "Promo ID required" });

            // Increment impression count
            const { data, error } = await supabase.rpc('increment_promo_impressions', { target_id: promo_id });
            
            if (error) {
                // Fallback if RPC doesn't exist yet
                const { data: promo } = await supabase.from('promos').select('impressions').eq('id', promo_id).single();
                await supabase.from('promos').update({ impressions: (promo?.impressions || 0) + 1 }).eq('id', promo_id);
            }
            return res.json({ success: true });
        }

        // ADMIN ACTIONS
        const authHeader = req.headers.authorization;
        const pin = authHeader?.replace(/^Bearer\s+/i, '').trim();
        const isAdmin = (pin === '4574' || pin === '3620' || pin === 'EMP-admin');

        if (!isAdmin) return res.status(403).json({ error: "Admin access required" });

        if (action === 'list' && req.method === 'GET') {
            const { data, error } = await supabase.from('promos').select('*').order('created_at', { ascending: false });
            if (error) return res.status(500).json({ error: error.message });
            return res.json(data || []);
        }

        if (action === 'save' && req.method === 'POST') {
            const promo = req.body;
            if (!promo.id) {
                promo.id = 'promo_' + Date.now();
                promo.impressions = 0;
            }
            
            const { data, error } = await supabase.from('promos').upsert(promo).select().single();
            if (error) return res.status(500).json({ error: error.message });
            return res.json(data);
        }

        if (action === 'delete' && req.method === 'DELETE') {
            const { id } = req.query;
            const { error } = await supabase.from('promos').delete().eq('id', id);
            if (error) return res.status(500).json({ error: error.message });
            return res.json({ success: true });
        }

        return res.status(404).json({ error: 'Action not found' });
    } catch (e) {
        console.error("[Promos API] Error:", e);
        res.status(500).json({ error: e.message });
    }
}
