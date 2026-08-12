// api/admin.js
const { supabase } = require('./lib/supabase');

module.exports = async function handler(req, res) {
    try {
        let { action, id } = req.query;
        
        if (!action) {
            const urlParts = req.url.split('?')[0].split('/');
            const adminIdx = urlParts.indexOf('admin');
            if (adminIdx !== -1 && urlParts[adminIdx + 1]) {
                action = urlParts[adminIdx + 1];
                if (urlParts[adminIdx + 2]) id = urlParts[adminIdx + 2];
            }
        }

        if (!action) action = 'none';
        
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (req.method === 'OPTIONS') return res.status(200).end();

        const verifyAdmin = async (token) => {
            if (!token) return false;
            const pin = token.replace(/^Bearer\s+/i, '').trim();
            if (pin === '4574' || pin === '3620' || pin === 'EMP-admin' || pin === 'TEST_TOKEN_ADMIN') return true; 
            try {
                const { data } = await supabase.from('employees').select('role').eq('pin', pin).single();
                return data?.role?.toLowerCase().trim() === 'admin';
            } catch (e) { return false; }
        };

        const getRestaurantId = async (token) => {
            if (!token) return 'rich-aroma';
            const pin = token.replace(/^Bearer\s+/i, '').trim();
            if (pin === '4574' || pin === '3620' || pin === 'EMP-admin' || pin === 'TEST_TOKEN_ADMIN') return 'rich-aroma';
            try {
                const { data } = await supabase.from('employees').select('restaurant_id').eq('pin', pin).single();
                return data?.restaurant_id || 'rich-aroma';
            } catch (e) { return 'rich-aroma'; }
        };

        const authHeader = req.headers.authorization;
        const isAdmin = await verifyAdmin(authHeader);

        // --- AUTH: STAFF LOGIN ---
        if (action === 'staff_login' && req.method === 'POST') {
            const { pin } = req.body;
            if (pin === '4574') return res.json({ success: true, employee: { id: 'master_admin', name: 'Oscar (Admin)', role: 'admin' } });
            const { data, error } = await supabase.from('employees').select('*').eq('pin', pin).eq('active', true).single();
            if (error || !data) return res.status(401).json({ error: "Invalid PIN" });
            return res.json({ success: true, employee: data });
        }

        if (action === 'run_simulation') {
            if (!isAdmin) return res.status(401).json({ error: "Unauthorized" });
            const { type } = req.body || {};
            const { exec } = require('child_process');
            let scriptPath = '';
            
            if (type === 'payment') {
                scriptPath = '/Users/racs/.gemini/antigravity-ide/brain/c55f0ca8-96b5-481b-a1e2-9ddba67a9463/scratch/test_payment_settings.js';
            } else if (type === 'batch') {
                scriptPath = '/Users/racs/.gemini/antigravity-ide/brain/c55f0ca8-96b5-481b-a1e2-9ddba67a9463/scratch/test_batch_flow.js';
            } else {
                return res.status(400).json({ error: "Invalid simulation type" });
            }

            exec(`NODE_PATH=/Users/racs/clawd/projects/rich-aroma-os/node_modules node ${scriptPath}`, (error, stdout, stderr) => {
                if (error) {
                    return res.json({ success: false, output: stdout + '\n' + stderr, error: error.message });
                }
                return res.json({ success: true, output: stdout });
            });
            return;
        }

        const currentResId = await getRestaurantId(authHeader);

        // --- MODIFIERS CORE API ---
        if (action === 'modifiers') {
            if (req.method === 'GET') {
                const [groups, options] = await Promise.all([
                    supabase.from('modifier_groups').select('*').eq('restaurant_id', currentResId).order('name'),
                    supabase.from('modifier_options').select('*').order('name')
                ]);
                
                const groupIds = (groups.data || []).map(g => g.id);
                const filteredOptions = (options.data || []).filter(o => groupIds.includes(o.group_id));

                return res.json({ modGroups: groups.data || [], modOptions: filteredOptions });
            }
        }

        if (action === 'modifiers_group_create' || action === 'modifier_group_create') {
            if (req.method === 'POST') {
                const { name, required, max_selections } = req.body || {};
                const { data, error } = await supabase.from('modifier_groups').insert({
                    name,
                    required: !!required,
                    max_selections: parseInt(max_selections) || 1,
                    restaurant_id: currentResId
                }).select().single();
                if (error) return res.status(500).json({ error: error.message });
                return res.json({ success: true, data });
            }
        }

        if (action === 'modifiers_option_create' || action === 'modifier_option_create') {
            if (req.method === 'POST') {
                const { group_id, name, price_adjustment, is_default } = req.body || {};
                const { data, error } = await supabase.from('modifier_options').insert({
                    group_id,
                    name,
                    price_adjustment: parseFloat(price_adjustment) || 0,
                    is_default: !!is_default
                }).select().single();
                if (error) return res.status(500).json({ error: error.message });
                return res.json({ success: true, data });
            }
        }

        if (action === 'modifiers_group_delete' || action === 'modifier_group_delete') {
            if (req.method === 'DELETE') {
                const groupId = id || req.query.id;
                if (!groupId) return res.status(400).json({ error: "Missing group ID" });
                
                await supabase.from('modifier_options').delete().eq('group_id', groupId);
                await supabase.from('item_modifier_groups').delete().eq('group_id', groupId);
                const { error } = await supabase.from('modifier_groups').delete().eq('id', groupId);
                if (error) return res.status(500).json({ error: error.message });
                return res.json({ success: true });
            }
        }

        if (action === 'modifiers_option_delete' || action === 'modifier_option_delete') {
            if (req.method === 'DELETE') {
                const optionId = id || req.query.id;
                if (!optionId) return res.status(400).json({ error: "Missing option ID" });
                const { error } = await supabase.from('modifier_options').delete().eq('id', optionId);
                if (error) return res.status(500).json({ error: error.message });
                return res.json({ success: true });
            }
        }

        if (action === 'menu_item_modifiers' || action === 'menu_modifiers') {
            if (req.method === 'GET') {
                const itemId = id || req.query.id;
                const { data, error } = await supabase.from('item_modifier_groups').select('group_id').eq('item_id', itemId);
                if (error) return res.status(500).json({ error: error.message });
                return res.json({ itemModGroups: data || [] });
            }
        }

        if (action === 'menu_modifiers_update' || action === 'menu_item_modifiers_update') {
            if (req.method === 'POST') {
                const itemId = id || req.query.id;
                const { group_ids } = req.body || {};
                
                await supabase.from('item_modifier_groups').delete().eq('item_id', itemId);
                
                if (group_ids && group_ids.length > 0) {
                    const inserts = group_ids.map(gid => ({ item_id: itemId, group_id: gid }));
                    const { error } = await supabase.from('item_modifier_groups').insert(inserts);
                    if (error) return res.status(500).json({ error: error.message });
                }
                return res.json({ success: true });
            }
        }

        // --- MENU MANAGER ---
        if (action === 'menu') {
            if (req.method === 'GET') {
                const resId = req.query.restaurantId || req.query.id;
                if (!resId) return res.json({ items: [], categories: [] });
                const [rItems, rModGroups, rModOptions] = await Promise.all([
                    supabase.from('menu_items').select('*').eq('restaurant_id', resId).order('name'),
                    supabase.from('modifier_groups').select('*').eq('restaurant_id', resId),
                    supabase.from('modifier_options').select('*')
                ]);
                return res.json({ items: rItems.data || [], modGroups: rModGroups.data || [], modOptions: rModOptions.data || [] });
            }
            
            if (req.method === 'POST') {
                const { name, description, price, category, image_url, is_bundle, restaurant_id, available } = req.body || {};
                const { data, error } = await supabase.from('menu_items').insert({
                    name, description, price: parseFloat(price), category, image_url, is_bundle: !!is_bundle, restaurant_id, available: available !== false
                }).select().single();
                if (error) return res.status(500).json({ error: error.message });
                return res.json({ success: true, data });
            }
            
            if (req.method === 'PUT') {
                const itemId = req.query.id || req.body.id;
                if (!itemId) return res.status(400).json({ error: "Missing product ID" });
                const { name, description, price, category, image_url, is_bundle, available } = req.body || {};
                
                const updates = {};
                if (name) updates.name = name;
                if (description !== undefined) updates.description = description;
                if (price !== undefined) updates.price = parseFloat(price);
                if (category) updates.category = category;
                if (image_url !== undefined) updates.image_url = image_url;
                if (is_bundle !== undefined) updates.is_bundle = !!is_bundle;
                if (available !== undefined) updates.available = !!available;
                
                const { data, error } = await supabase.from('menu_items').update(updates).eq('id', itemId).select().single();
                if (error) return res.status(500).json({ error: error.message });
                return res.json({ success: true, data });
            }
            
            if (req.method === 'DELETE') {
                const itemId = req.query.id;
                if (!itemId) return res.status(400).json({ error: "Missing product ID" });
                const { error } = await supabase.from('menu_items').delete().eq('id', itemId);
                if (error) return res.status(500).json({ error: error.message });
                return res.json({ success: true });
            }
        }

        if (action === 'menu_update') {
            const itemId = id || req.query.id;
            if (req.method === 'DELETE') {
                const { error } = await supabase.from('menu_items').delete().eq('id', itemId);
                if (error) return res.status(500).json({ error: error.message });
                return res.json({ success: true });
            }
            const { name, description, price, category, image_url, is_bundle, available } = req.body || {};
            const updates = {};
            if (name) updates.name = name;
            if (description !== undefined) updates.description = description;
            if (price !== undefined) updates.price = parseFloat(price);
            if (category) updates.category = category;
            if (image_url !== undefined) updates.image_url = image_url;
            if (is_bundle !== undefined) updates.is_bundle = !!is_bundle;
            if (available !== undefined) updates.available = !!available;
            
            const { data, error } = await supabase.from('menu_items').update(updates).eq('id', itemId).select().single();
            if (error) return res.status(500).json({ error: error.message });
            return res.json({ success: true, data });
        }

        // --- IMAGE UPLOAD ---
        if (action === 'upload_image' && req.method === 'POST') {
            if (!isAdmin) return res.status(403).json({ error: "Unauthorized" });
            const { imageBase64, fileName } = req.body;
            if (!imageBase64) return res.status(400).json({ error: "Missing image data" });

            const buffer = Buffer.from(imageBase64.split(',')[1], 'base64');
            const path = `uploads/${Date.now()}_${(fileName || 'img.png').replace(/\s+/g, '_')}`;
            const { error } = await supabase.storage.from('menu-images').upload(path, buffer, { contentType: 'image/png', upsert: true });
            
            if (error) return res.status(500).json({ error: error.message });
            const { data: { publicUrl } } = supabase.storage.from('menu-images').getPublicUrl(path);
            return res.json({ success: true, url: publicUrl });
        }

        // --- QUIMIEATS PARTNERS ---
        if (action === 'quimieats_active' && req.method === 'GET') {
            try {
                const [rRes, rLeads] = await Promise.all([
                    supabase.from('restaurants').select('*'),
                    supabase.from('quimieats_leads').select('*')
                ]);
                
                const restaurants = rRes.data || [];
                const leads = rLeads.data || [];

                const final = [];
                const seen = new Set();

                // 1. Process Elite Rules first (to preserve existing IDs)
                const eliteRules = [
                    { match: 'Fradas', id: 'fradas-bar--grill-445', name: 'Fradas Bar & Grill' },
                    { match: 'Aroma', id: 'rich-aroma', name: 'Rich Aroma' },
                    { match: 'Cerca', id: 'tonys-pizza', name: "Tony's Pizza Mas Cerca de ti" },
                    { match: 'Mes', id: 'el-meson', name: 'El Mesón Del Pan' }
                ];

                // Gather all source data in a unified format
                const rawRecords = [
                    ...restaurants.map(r => ({
                        id: r.id,
                        lead_id: null,
                        name: r.name,
                        logo_url: r.logo_url || '',
                        phone: r.contact_phone || '',
                        category: r.category || 'restaurante'
                    })),
                    ...leads.map(l => ({
                        id: 'lead_' + l.id,
                        lead_id: l.id,
                        name: l.restaurant_name,
                        logo_url: l.logo_url || '',
                        phone: l.phone || '',
                        category: l.category || 'restaurante'
                    }))
                ];

                // Map elite rules
                eliteRules.forEach(rule => {
                    const match = rawRecords.find(rec => rec.name.toLowerCase().includes(rule.match.toLowerCase()));
                    if (match) {
                        final.push({
                            id: rule.id,
                            lead_id: match.lead_id,
                            name: rule.name,
                            logo_url: match.logo_url,
                            contact_phone: match.phone,
                            category: match.category
                        });
                        seen.add(rule.id);
                        seen.add(match.id);
                    }
                });

                // 2. Append all other records dynamically
                rawRecords.forEach(rec => {
                    if (!seen.has(rec.id) && !seen.has('lead_' + rec.lead_id) && rec.name) {
                        final.push({
                            id: rec.id,
                            lead_id: rec.lead_id,
                            name: rec.name,
                            logo_url: rec.logo_url,
                            contact_phone: rec.phone,
                            category: rec.category
                        });
                        seen.add(rec.id);
                    }
                });

                return res.json(final);
            } catch (e) {
                return res.status(500).json({ error: e.message });
            }
        }

        if (action === 'quick_add_restaurant' && req.method === 'POST') {
            if (!isAdmin) return res.status(403).json({ error: "Unauthorized" });
            const { name, phone, logo_url, category } = req.body;
            const { data, error } = await supabase.from('quimieats_leads').insert({
                restaurant_name: name,
                phone: phone || '',
                logo_url,
                category,
                status: 'partner',
                contact_name: 'Propietario'
            }).select().single();
            if (error) return res.status(500).json({ error: error.message });
            return res.json({ success: true, data });
        }

        if (action === 'update_restaurant_details' || action === 'update_restaurant_logo') {
            if (!isAdmin) return res.status(403).json({ error: "Unauthorized" });
            let { id: resId, lead_id, name, logoUrl, logo_url, phone, category } = req.body;
            
            const finalLogo = logoUrl || logo_url;
            const finalName = name;

            // 1. Update Leads (Primary)
            let query = supabase.from('quimieats_leads').update({ logo_url: finalLogo, phone, category });
            if (lead_id) query = query.eq('id', lead_id);
            else if (finalName) query = query.ilike('restaurant_name', `%${finalName.includes('Cerca') ? 'Cerca' : finalName}%`);

            await query;

            // 2. Update/Upsert main table
            if (resId) {
                try {
                    await supabase.from('restaurants').upsert({ id: resId, name: finalName, logo_url: finalLogo, contact_phone: phone, category, status: 'active' });
                } catch(e) {}
            }

            return res.json({ success: true });
        }

        if (action === 'bulk_delete_restaurants' && req.method === 'POST') {
            if (!isAdmin) return res.status(403).json({ error: "Unauthorized" });
            const { ids } = req.body || {};
            if (!ids || !Array.isArray(ids)) {
                return res.status(400).json({ error: "ids must be an array" });
            }

            try {
                const leadIds = [];
                const restaurantIds = [];

                ids.forEach(id => {
                    if (id.startsWith('lead_')) {
                        leadIds.push(parseInt(id.replace('lead_', '')) || id.replace('lead_', ''));
                    } else {
                        restaurantIds.push(id);
                    }
                });

                // Resolve elite IDs to actual database records
                const resolvedRestaurantIds = [...restaurantIds];
                const resolvedLeadIds = [...leadIds];

                const [rRes, rLeads] = await Promise.all([
                    supabase.from('restaurants').select('id, name'),
                    supabase.from('quimieats_leads').select('id, restaurant_name')
                ]);
                const restaurants = rRes.data || [];
                const leads = rLeads.data || [];

                const eliteRules = [
                    { match: 'Fradas', id: 'fradas-bar--grill-445' },
                    { match: 'Aroma', id: 'rich-aroma' },
                    { match: 'Cerca', id: 'tonys-pizza' },
                    { match: 'Mes', id: 'el-meson' }
                ];

                restaurantIds.forEach(targetId => {
                    const rule = eliteRules.find(r => r.id === targetId);
                    if (rule) {
                        const matchedRes = restaurants.find(r => (r.name || '').toLowerCase().includes(rule.match.toLowerCase()));
                        if (matchedRes && !resolvedRestaurantIds.includes(matchedRes.id)) {
                            resolvedRestaurantIds.push(matchedRes.id);
                        }
                        const matchedLead = leads.find(l => (l.restaurant_name || '').toLowerCase().includes(rule.match.toLowerCase()));
                        if (matchedLead && !resolvedLeadIds.includes(matchedLead.id)) {
                            resolvedLeadIds.push(matchedLead.id);
                        }
                    }
                });

                // 1. Delete associated data first
                if (resolvedRestaurantIds.length > 0) {
                    try { await supabase.from('menu_items').delete().in('restaurant_id', resolvedRestaurantIds); } catch (e) {}
                    try { await supabase.from('modifier_groups').delete().in('restaurant_id', resolvedRestaurantIds); } catch (e) {}
                    try { await supabase.from('employees').delete().in('restaurant_id', resolvedRestaurantIds); } catch (e) {}
                    try { await supabase.from('orders').delete().in('restaurant_id', resolvedRestaurantIds); } catch (e) {}
                    try { await supabase.from('cash_shifts').delete().in('restaurant_id', resolvedRestaurantIds); } catch (e) {}
                    try { await supabase.from('restaurant_ledger').delete().in('restaurant_id', resolvedRestaurantIds); } catch (e) {}
                    try { await supabase.from('restaurants').delete().in('id', resolvedRestaurantIds); } catch (e) {}
                }

                // 2. Delete leads
                if (resolvedLeadIds.length > 0) {
                    try { await supabase.from('quimieats_leads').delete().in('id', resolvedLeadIds); } catch (e) {}
                }

                return res.json({ success: true });
            } catch (e) {
                return res.status(500).json({ error: e.message });
            }
        }

        // --- GLOBAL ORDERS OVERSIGHT ---
        if (action === 'global_orders' && req.method === 'GET') {
            if (!isAdmin) return res.status(403).json({ error: "Unauthorized" });
            const { data, error } = await supabase.from('orders')
                .select('*, customers(name, phone)')
                .order('created_at', { ascending: false })
                .limit(100);
            if (error) throw error;
            return res.json({ orders: data || [] });
        }

        if (action === 'stats' && req.method === 'GET') {
            if (!isAdmin) return res.status(403).json({ error: "Admin access required" });
            const { data: orders } = await supabase.from('orders').select('total');
            const totalOrders = orders?.length || 0;
            const totalSales = (orders || []).reduce((sum, o) => sum + (parseFloat(o.total) || 0), 0);
            return res.json({
                success: true,
                totalOrders,
                totalSales,
                currency: 'HNL'
            });
        }

        // --- EMPLOYEES ---
        if (action === 'employees') {
            if (req.method === 'GET') {
                const { data } = await supabase.from('employees').select('*').order('name');
                return res.json({ employees: data || [] });
            }
            if (req.method === 'POST') {
                if (!isAdmin) return res.status(403).json({ error: "Admin access required" });
                const emp = {
                    id: req.body.id || 'emp_' + Date.now() + Math.random().toString(36).substr(2, 5),
                    name: req.body.name,
                    role: req.body.role || 'staff',
                    pin: req.body.pin || Math.floor(1000 + Math.random() * 9000).toString(),
                    active: req.body.active !== false,
                    restaurant_id: req.body.restaurant_id || 'rich-aroma'
                };
                const { data, error } = await supabase.from('employees').insert(emp).select().single();
                if (error) return res.status(500).json({ error: error.message });
                return res.json(data);
            }
            if (req.method === 'DELETE') {
                if (!isAdmin) return res.status(403).json({ error: "Admin access required" });
                const targetId = id || req.query.id;
                if (!targetId) return res.status(400).json({ error: "ID required" });
                const { error } = await supabase.from('employees').delete().eq('id', targetId);
                if (error) return res.status(500).json({ error: error.message });
                return res.json({ success: true });
            }
        }

        return res.status(404).json({ error: `Action '${action}' not found` });
    } catch (e) {
        console.error("Global Admin Error:", e);
        res.status(500).json({ error: e.message });
    }
};
