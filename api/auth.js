// api/auth.js
const { supabase } = require('./lib/supabase');

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).end();

    const { action } = req.query; // ?action=login or ?action=register

    try {
        if (action === 'login') {
            const { identifier, secret, type } = req.body;
            let user;
            if (type === 'phone') {
                const phone = identifier.replace(/\D/g, '');
                const { data } = await supabase.from('customers').select('*').eq('phone', phone).single();
                
                if (!data) return res.status(404).json({ error: 'Customer not found' });
                
                // If they have no PIN set yet (Ghost Account)
                if (!data.pin) {
                    return res.status(403).json({ 
                        error: 'Security PIN not set', 
                        code: 'NO_PIN_SET' 
                    });
                }

                if (data.pin !== secret) return res.status(401).json({ error: 'Invalid credentials' });
                user = data;
            } else {
                const email = identifier.toLowerCase();
                const { data } = await supabase.from('customers').select('*').eq('email', email).single();
                if (!data || data.password !== secret) return res.status(401).json({ error: 'Invalid credentials' });
                user = data;
            }
            return res.json({ success: true, user });
        }

        if (action === 'register') {
            const { name, phone, email, secret, type, action: subAction, pin } = req.body; 
            const cleanPhone = phone ? phone.replace(/\D/g, '') : null;
            const finalPin = pin || secret; // Support both names for robustness

            // SPECIAL CASE: Setting PIN for an existing staff-created account
            if (subAction === 'set_ghost_pin') {
                const { data, error } = await supabase.from('customers')
                    .update({ pin: finalPin })
                    .eq('phone', cleanPhone)
                    .select().single();
                if (error) throw error;
                return res.json({ success: true, user: data });
            }

            const cleanEmail = email ? email.toLowerCase() : null;

            if (cleanPhone) {
                const { data } = await supabase.from('customers').select('id, tags').eq('phone', cleanPhone).maybeSingle();
                if (data) {
                    if (data.tags && data.tags.includes('pending_onboarding')) {
                        // This is a pending onboarding profile. Let's update it!
                        const { data: updated, error: updErr } = await supabase.from('customers').update({
                            name,
                            email: cleanEmail,
                            pin: finalPin,
                            password: type === 'email' ? secret : null,
                            referral_code: req.body.referredBy || null,
                            tags: (data.tags || []).filter(t => t !== 'pending_onboarding')
                        }).eq('id', data.id).select().single();
                        
                        if (updErr) throw updErr;
                        return res.json({ success: true, user: updated });
                    }
                    return res.status(400).json({ error: 'Phone already registered' });
                }
            }

            // Generate a unique random ID (C-XXXXXX)
            const randomSuffix = Math.random().toString(36).substring(2, 8).toUpperCase();
            const newId = `C-${randomSuffix}`;

            const newUser = {
                id: newId,
                name,
                phone: cleanPhone,
                email: cleanEmail,
                points: 0,
                tier: 'bronze',
                pin: finalPin,
                password: type === 'email' ? secret : null,
                referral_code: req.body.referredBy || null
            };

            const { data, error } = await supabase.from('customers').insert(newUser).select().single();
            if (error) throw error;
            return res.json({ success: true, user: data });
        }

        res.status(400).json({ error: 'Invalid action' });

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
}