// api/admin.js
const { supabase } = require('./lib/supabase');
const { isMasterPin, isAdminCredential } = require('./lib/auth');
const { pinThrottleCheck, pinThrottleFail, pinThrottleSuccess } = require('./lib/rate-limit');

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
            if (isAdminCredential(pin)) return true;
            try {
                const { data } = await supabase.from('employees').select('role').eq('pin', pin).single();
                return data?.role?.toLowerCase().trim() === 'admin';
            } catch (e) { return false; }
        };

        const getRestaurantId = async (token) => {
            if (!token) return 'rich-aroma';
            const pin = token.replace(/^Bearer\s+/i, '').trim();
            if (isAdminCredential(pin)) return 'rich-aroma';
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
            // SEC-FIX 4 (F12): throttle PIN guessing; never echo the PIN back.
            if (pinThrottleCheck(req, pin)) return res.status(429).json({ error: "Demasiados intentos. Espera unos minutos." });
            if (isMasterPin(pin)) { pinThrottleSuccess(req, pin); return res.json({ success: true, employee: { id: 'master_admin', name: 'Oscar (Admin)', role: 'admin' } }); }
            const { data, error } = await supabase.from('employees').select('*').eq('pin', pin).eq('active', true).single();
            if (error || !data) { pinThrottleFail(req, pin); return res.status(401).json({ error: "Invalid PIN" }); }
            pinThrottleSuccess(req, pin);
            const { pin: _staffPin, ...safeEmployee } = data;
            return res.json({ success: true, employee: safeEmployee });
        }

        // --- Consolidated handler (2026-10-21): shop menu read API,
        // code unchanged in api/lib/handler-v2-menu.js; /api/v2-menu kept via vercel.json.
        if (action === 'menu_v2') return require('./lib/handler-v2-menu')(req, res);

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
                if (!isAdmin) return res.status(403).json({ error: "Unauthorized" });
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
                if (!isAdmin) return res.status(403).json({ error: "Unauthorized" });
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
                if (!isAdmin) return res.status(403).json({ error: "Unauthorized" });
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
                if (!isAdmin) return res.status(403).json({ error: "Unauthorized" });
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
                if (!isAdmin) return res.status(403).json({ error: "Unauthorized" });
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
            const fs = require('fs');
            const path = require('path');
            const menuJsonPath = path.join(__dirname, '..', 'data', 'menu.json');

            const loadLocalMenu = () => {
                if (fs.existsSync(menuJsonPath)) {
                    try { return JSON.parse(fs.readFileSync(menuJsonPath, 'utf8')); } catch(e) { return { categories: [] }; }
                }
                return { categories: [] };
            };

            const saveLocalMenu = (menuData) => {
                try { fs.writeFileSync(menuJsonPath, JSON.stringify(menuData, null, 2)); } catch(e) { console.error("Error writing menu.json:", e); }
            };

            if (req.method === 'GET') {
                const resId = req.query.restaurantId || req.query.id;
                let dbItems = null;
                let dbModGroups = null;
                let dbModOptions = null;

                try {
                    const [rItems, rModGroups, rModOptions] = await Promise.all([
                        supabase.from('menu_items').select('*').eq('restaurant_id', resId || 'rich-aroma').order('name'),
                        supabase.from('modifier_groups').select('*').eq('restaurant_id', resId || 'rich-aroma'),
                        supabase.from('modifier_options').select('*')
                    ]);
                    if (rItems.data && rItems.data.length > 0) {
                        return res.json({ items: rItems.data || [], modGroups: rModGroups.data || [], modOptions: rModOptions.data || [] });
                    }
                } catch(sbErr) {
                    console.warn("[admin.js] Supabase menu query failed, falling back to data/menu.json:", sbErr.message);
                }

                // Fallback to data/menu.json
                const local = loadLocalMenu();
                const flattened = [];
                (local.categories || []).forEach(cat => {
                    (cat.items || []).forEach(it => {
                        flattened.push({
                            id: it.id,
                            name: it.name,
                            price: it.price,
                            category: cat.name || cat.id,
                            image_url: it.image_url || it.image || '',
                            description: it.description || '',
                            available: it.available !== false,
                            restaurant_id: resId || 'rich-aroma'
                        });
                    });
                });
                return res.json({ items: flattened, modGroups: [], modOptions: [] });
            }
            
            // PATCH /api/admin/menu/{id} — partial update. This is the path
            // the Steps editor (saveRecipeSteps) has always called with
            // { recipe_steps: [...] }; until now no PATCH branch existed,
            // so step saves fell through to the 404 at the bottom.
            if (req.method === 'PATCH') {
                if (!isAdmin) return res.status(403).json({ error: "Unauthorized" });
                const itemId = id || req.query.id || (req.body && req.body.id);
                if (!itemId) return res.status(400).json({ error: "Missing product ID" });
                const b = req.body || {};
                const updates = {};
                if (b.name) updates.name = b.name;
                if (b.description !== undefined) updates.description = b.description;
                if (b.price !== undefined) updates.price = parseFloat(b.price);
                if (b.category) updates.category = b.category;
                if (b.image_url !== undefined) updates.image_url = b.image_url;
                if (b.is_bundle !== undefined) updates.is_bundle = !!b.is_bundle;
                if (b.is_house_made !== undefined) updates.is_house_made = !!b.is_house_made;
                if (b.available !== undefined) updates.available = !!b.available;
                if (b.recipe_steps !== undefined) {
                    if (!Array.isArray(b.recipe_steps)) return res.status(400).json({ error: "recipe_steps must be an array" });
                    updates.recipe_steps = b.recipe_steps.map(s => String(s).trim()).filter(s => s !== '');
                }
                if (Object.keys(updates).length === 0) return res.status(400).json({ error: "Nothing to update" });

                const { error } = await supabase.from('menu_items').update(updates).eq('id', itemId);
                if (error) {
                    if (updates.recipe_steps !== undefined && /recipe_steps/.test(error.message || '')) {
                        return res.status(500).json({ error: "La columna recipe_steps no existe — corré admin-recipes-migration.sql en Supabase." });
                    }
                    return res.status(500).json({ error: error.message });
                }

                const local = loadLocalMenu();
                (local.categories || []).forEach(cat => {
                    (cat.items || []).forEach(it => { if (it.id === itemId) Object.assign(it, updates); });
                });
                saveLocalMenu(local);

                return res.json({ success: true, data: updates });
            }

            // SEC-FIX 4 (F7): menu/modifier WRITES require admin — the gate
            // existed in this file but only covered later actions, leaving
            // the whole menu write surface open. Every write in this block
            // hits BOTH Supabase and the local data/menu.json shadow copy;
            // each gate below sits above both writes. (Reads above stay
            // public: they mirror the public menu.)
            if (req.method === 'POST') {
                if (!isAdmin) return res.status(403).json({ error: "Unauthorized" });
                const { name, description, price, category, image_url, is_bundle, is_house_made, restaurant_id, available } = req.body || {};
                const newItem = {
                    id: 'item_' + Date.now(),
                    name: name || 'New Item',
                    description: description || '',
                    price: parseFloat(price) || 0,
                    category: category || 'General',
                    image_url: image_url || '',
                    is_bundle: !!is_bundle,
                    is_house_made: !!is_house_made,
                    restaurant_id: restaurant_id || 'rich-aroma',
                    available: available !== false
                };

                try {
                    await supabase.from('menu_items').insert(newItem);
                } catch(e) {}

                // Update local menu.json
                const local = loadLocalMenu();
                if (!Array.isArray(local.categories)) local.categories = [];
                let targetCat = local.categories.find(c => (c.name || '').toLowerCase() === (newItem.category || '').toLowerCase());
                if (!targetCat) {
                    targetCat = { id: (newItem.category || 'general').toLowerCase().replace(/\s+/g, '_'), name: newItem.category || 'General', items: [] };
                    local.categories.push(targetCat);
                }
                if (!Array.isArray(targetCat.items)) targetCat.items = [];
                targetCat.items.push(newItem);
                saveLocalMenu(local);

                return res.json({ success: true, data: newItem });
            }
            
            if (req.method === 'PUT') {
                if (!isAdmin) return res.status(403).json({ error: "Unauthorized" });
                const itemId = req.query.id || req.body.id;
                if (!itemId) return res.status(400).json({ error: "Missing product ID" });
                const { name, description, price, category, image_url, is_bundle, is_house_made, available, recipe_steps } = req.body || {};

                const updates = {};
                if (name) updates.name = name;
                if (description !== undefined) updates.description = description;
                if (price !== undefined) updates.price = parseFloat(price);
                if (category) updates.category = category;
                if (image_url !== undefined) updates.image_url = image_url;
                if (is_bundle !== undefined) updates.is_bundle = !!is_bundle;
                if (is_house_made !== undefined) updates.is_house_made = !!is_house_made;
                if (available !== undefined) updates.available = !!available;
                if (Array.isArray(recipe_steps)) updates.recipe_steps = recipe_steps.map(s => String(s).trim()).filter(s => s !== '');
                
                try {
                    await supabase.from('menu_items').update(updates).eq('id', itemId);
                } catch(e) {}

                // Update local menu.json
                const local = loadLocalMenu();
                let foundItem = null;
                (local.categories || []).forEach(cat => {
                    (cat.items || []).forEach(it => {
                        if (it.id === itemId) {
                            Object.assign(it, updates);
                            foundItem = it;
                        }
                    });
                });
                saveLocalMenu(local);

                return res.json({ success: true, data: foundItem || updates });
            }
            
            if (req.method === 'DELETE') {
                if (!isAdmin) return res.status(403).json({ error: "Unauthorized" });
                const itemId = req.query.id;
                if (!itemId) return res.status(400).json({ error: "Missing product ID" });
                try {
                    await supabase.from('menu_items').delete().eq('id', itemId);
                } catch(e) {}

                const local = loadLocalMenu();
                (local.categories || []).forEach(cat => {
                    if (Array.isArray(cat.items)) {
                        cat.items = cat.items.filter(it => it.id !== itemId);
                    }
                });
                saveLocalMenu(local);

                return res.json({ success: true, deleted: itemId });
            }
        }

        if (action === 'menu_update') {
            // SEC-FIX 4 (F7): one gate at the top covers both branches below
            // (DELETE and update) and both stores (Supabase + the local
            // data/menu.json fs.writeFileSync writes).
            if (!isAdmin) return res.status(403).json({ error: "Unauthorized" });
            const fs = require('fs');
            const path = require('path');
            const menuJsonPath = path.join(__dirname, '..', 'data', 'menu.json');
            const itemId = id || req.query.id;

            if (req.method === 'DELETE') {
                try { await supabase.from('menu_items').delete().eq('id', itemId); } catch(e) {}
                if (fs.existsSync(menuJsonPath)) {
                    try {
                        const local = JSON.parse(fs.readFileSync(menuJsonPath, 'utf8'));
                        (local.categories || []).forEach(cat => {
                            if (Array.isArray(cat.items)) cat.items = cat.items.filter(it => it.id !== itemId);
                        });
                        fs.writeFileSync(menuJsonPath, JSON.stringify(local, null, 2));
                    } catch(e) {}
                }
                return res.json({ success: true });
            }

            const { name, description, price, category, image_url, is_bundle, is_house_made, available } = req.body || {};
            const updates = {};
            if (name) updates.name = name;
            if (description !== undefined) updates.description = description;
            if (price !== undefined) updates.price = parseFloat(price);
            if (category) updates.category = category;
            if (image_url !== undefined) updates.image_url = image_url;
            if (is_bundle !== undefined) updates.is_bundle = !!is_bundle;
                if (is_house_made !== undefined) updates.is_house_made = !!is_house_made;
            if (available !== undefined) updates.available = !!available;
            
            try { await supabase.from('menu_items').update(updates).eq('id', itemId); } catch(e) {}

            if (fs.existsSync(menuJsonPath)) {
                try {
                    const local = JSON.parse(fs.readFileSync(menuJsonPath, 'utf8'));
                    (local.categories || []).forEach(cat => {
                        (cat.items || []).forEach(it => {
                            if (it.id === itemId) Object.assign(it, updates);
                        });
                    });
                    fs.writeFileSync(menuJsonPath, JSON.stringify(local, null, 2));
                } catch(e) {}
            }

            return res.json({ success: true, data: updates });
        }

        // --- INVENTORY CATALOG + RECIPES (admin-recipes build, 2026-10-26) ---
        // The admin UI for this layer (Raw Ingredients & Inventory section,
        // per-item Ingredients modal) shipped long before its backend: every
        // action below was called by public/admin.html but never implemented
        // here. Shapes follow the FRONTEND's field usage exactly:
        //   GET    action=inventory                  -> [ {id, name, slug, unit, current_stock, min_stock, daily_count_role, ...} ]
        //   POST   action=inventory_update           -> upsert by id (full save OR partial, e.g. {id, daily_count_role})
        //   DELETE action=inventory_delete&id=       -> deletes the catalog row + its recipe links
        //   GET    action=menu_item_ingredients&id=  -> [ {id, menu_item_id, inventory_item_id, quantity, unit, step_no, inventory:{...}} ]
        //   POST   action=menu_item_ingredient_add   -> {menu_item_id, inventory_item_id, quantity, unit, step_no?}
        //   DELETE action=menu_item_ingredient_delete&id=
        // Tables: `inventory` + `menu_item_ingredients` (rebuild-v4 shapes,
        // see admin-recipes-migration.sql). The catalog row's `slug` is the
        // join key the modifier-delta table (modifier_ingredients) uses —
        // hyphenated, accent-free, matching the seed-v3 slug contract.
        const slugifyInv = (s) => String(s || '')
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

        if (action === 'inventory' && req.method === 'GET') {
            if (!isAdmin) return res.status(403).json({ error: "Unauthorized" });
            const { data, error } = await supabase.from('inventory').select('*').order('name');
            if (error) return res.status(500).json({ error: error.message });
            return res.json(data || []);
        }

        if (action === 'inventory_update' && req.method === 'POST') {
            if (!isAdmin) return res.status(403).json({ error: "Unauthorized" });
            const b = req.body || {};
            const name = b.name !== undefined ? String(b.name).trim() : undefined;
            let invId = b.id ? String(b.id) : '';
            if (!invId && name) invId = name.toLowerCase().replace(/[^a-z0-9]/g, '_');
            if (!invId) return res.status(400).json({ error: "Missing ingredient id/name" });

            const row = { id: invId };
            if (name !== undefined) row.name = name;
            if (b.unit !== undefined) row.unit = String(b.unit);
            if (b.current_stock !== undefined) row.current_stock = parseFloat(b.current_stock) || 0;
            if (b.min_stock !== undefined) row.min_stock = parseFloat(b.min_stock) || 0;
            if (b.daily_count_role !== undefined) row.daily_count_role = String(b.daily_count_role);
            if (b.category !== undefined) row.category = b.category;
            if (b.cost_per_unit !== undefined) row.cost_per_unit = parseFloat(b.cost_per_unit);
            if (b.supplier !== undefined) row.supplier = b.supplier;
            const slug = b.slug ? slugifyInv(b.slug) : (name ? slugifyInv(name) : '');
            if (slug) row.slug = slug;

            let { data, error } = await supabase.from('inventory').upsert(row, { onConflict: 'id' }).select().single();
            if (error && row.slug) {
                // Pre-migration DB (no slug column yet): save without it
                // rather than failing the owner's edit.
                const { slug: _drop, ...rowNoSlug } = row;
                ({ data, error } = await supabase.from('inventory').upsert(rowNoSlug, { onConflict: 'id' }).select().single());
            }
            if (error) return res.status(500).json({ error: error.message });
            return res.json({ success: true, data });
        }

        if (action === 'inventory_delete' && req.method === 'DELETE') {
            if (!isAdmin) return res.status(403).json({ error: "Unauthorized" });
            const invId = id || req.query.id;
            if (!invId) return res.status(400).json({ error: "Missing ingredient ID" });
            try { await supabase.from('menu_item_ingredients').delete().eq('inventory_item_id', invId); } catch (e) {}
            const { error } = await supabase.from('inventory').delete().eq('id', invId);
            if (error) return res.status(500).json({ error: error.message });
            return res.json({ success: true });
        }

        if (action === 'menu_item_ingredients' && req.method === 'GET') {
            if (!isAdmin) return res.status(403).json({ error: "Unauthorized" });
            const itemId = id || req.query.id;
            if (!itemId) return res.status(400).json({ error: "Missing menu item ID" });
            let q = supabase.from('menu_item_ingredients').select('*').eq('menu_item_id', itemId);
            const { data, error } = await q;
            if (error) return res.status(500).json({ error: error.message });
            const rows = data || [];
            const invIds = [...new Set(rows.map(r => r.inventory_item_id || r.inventory_id).filter(Boolean))];
            let invById = {};
            if (invIds.length) {
                const { data: inv } = await supabase.from('inventory').select('id, name, slug, unit').in('id', invIds);
                (inv || []).forEach(v => { invById[v.id] = v; });
            }
            const out = rows.map(r => {
                const invId = r.inventory_item_id || r.inventory_id;
                const inv = invById[invId] || {};
                const qty = r.quantity !== undefined ? parseFloat(r.quantity) : parseFloat(r.qty);
                return {
                    id: r.id,
                    menu_item_id: r.menu_item_id,
                    inventory_item_id: invId,
                    inventory_id: invId,
                    quantity: qty,
                    qty: qty,
                    unit: r.unit || inv.unit || '',
                    step_no: (r.step_no === undefined || r.step_no === null) ? null : parseInt(r.step_no),
                    inventory: { id: invId, name: inv.name || invId, slug: inv.slug || invId, unit: inv.unit || r.unit || '' }
                };
            });
            return res.json(out);
        }

        if (action === 'menu_item_ingredient_add' && req.method === 'POST') {
            if (!isAdmin) return res.status(403).json({ error: "Unauthorized" });
            const b = req.body || {};
            const menuItemId = b.menu_item_id;
            const invId = b.inventory_item_id || b.inventory_id;
            const qtyRaw = b.quantity !== undefined ? b.quantity : b.qty;
            if (!menuItemId || !invId || qtyRaw === undefined || qtyRaw === null || qtyRaw === '') {
                return res.status(400).json({ error: "Missing menu_item_id, inventory_item_id or quantity" });
            }
            let unit = b.unit ? String(b.unit) : '';
            if (!unit) {
                const { data: inv } = await supabase.from('inventory').select('unit').eq('id', invId).maybeSingle();
                unit = inv?.unit || 'g';
            }
            let stepNo = null;
            if (b.step_no !== undefined && b.step_no !== null && b.step_no !== '') {
                const sn = parseInt(b.step_no);
                if (Number.isInteger(sn) && sn >= 1) stepNo = sn;
            }
            const row = {
                menu_item_id: menuItemId,
                inventory_item_id: invId,
                quantity: parseFloat(qtyRaw) || 0,
                unit
            };
            if (stepNo !== null) row.step_no = stepNo;
            let { data, error } = await supabase.from('menu_item_ingredients')
                .upsert(row, { onConflict: 'menu_item_id,inventory_item_id' }).select().single();
            if (error && stepNo !== null) {
                // Pre-migration DB (no step_no column yet): keep the link,
                // drop the step tie rather than failing the save.
                const { step_no: _drop, ...rowNoStep } = row;
                ({ data, error } = await supabase.from('menu_item_ingredients')
                    .upsert(rowNoStep, { onConflict: 'menu_item_id,inventory_item_id' }).select().single());
            }
            if (error) return res.status(500).json({ error: error.message });
            return res.json({ success: true, data });
        }

        if (action === 'menu_item_ingredient_delete' && req.method === 'DELETE') {
            if (!isAdmin) return res.status(403).json({ error: "Unauthorized" });
            const rowId = id || req.query.id;
            if (!rowId) return res.status(400).json({ error: "Missing ingredient link ID" });
            const { error } = await supabase.from('menu_item_ingredients').delete().eq('id', rowId);
            if (error) return res.status(500).json({ error: error.message });
            return res.json({ success: true });
        }

        // --- IMAGE UPLOAD ---
        if (action === 'upload_image' && req.method === 'POST') {
            if (!isAdmin) return res.status(403).json({ error: "Unauthorized" });
            const { imageBase64, fileName } = req.body;
            if (!imageBase64) return res.status(400).json({ error: "Missing image data" });

            const fs = require('fs');
            const path = require('path');
            const rawBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, "");
            const buffer = Buffer.from(rawBase64, 'base64');
            const safeName = `${Date.now()}_${(fileName || 'img.png').replace(/\s+/g, '_')}`;
            
            // 1. Always save locally to public/uploads/menu-images/
            const localDir = path.join(__dirname, '..', 'public', 'uploads', 'menu-images');
            if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
            fs.writeFileSync(path.join(localDir, safeName), buffer);
            let publicUrl = `/uploads/menu-images/${safeName}`;

            // 2. Try Supabase storage if active
            try {
                const storagePath = `uploads/${safeName}`;
                const { error: sbErr } = await supabase.storage.from('menu-images').upload(storagePath, buffer, { contentType: 'image/png', upsert: true });
                if (!sbErr) {
                    const { data: { publicUrl: sbUrl } } = supabase.storage.from('menu-images').getPublicUrl(storagePath);
                    if (sbUrl) publicUrl = sbUrl;
                }
            } catch (e) {}

            return res.json({ success: true, url: publicUrl });
        }

        // --- 4.1 Merchant Ledger & Payouts ---
        if (action === 'admin_merchant_balances' && req.method === 'GET') {
            try {
                const { data: restaurants } = await supabase.from('restaurants').select('id, name, status').neq('id', 'rich-aroma');
                const { data: ledger } = await supabase.from('quimieats_ledger').select('*');

                const balances = (restaurants || []).map(res => {
                    const resLedger = (ledger || []).filter(l => l.restaurant_id === res.id);
                    const netAmount = resLedger.reduce((sum, l) => sum + parseFloat(l.amount), 0);
                    
                    return {
                        id: res.id,
                        name: res.name,
                        status: res.status,
                        balance: netAmount,
                        ledger_rows: resLedger.length
                    };
                });

                return res.json(balances);
            } catch (e) {
                return res.status(500).json({ error: e.message });
            }
        }

        if (action === 'admin_create_ledger_entry' && req.method === 'POST') {
            if (!isAdmin) return res.status(403).json({ error: "Unauthorized" });
            const { restaurantId, amount, type, description } = req.body;
            if (!restaurantId || amount === undefined || !type) {
                return res.status(400).json({ error: "Missing parameters" });
            }

            try {
                // 1. Insert ledger entry
                const { data: entry, error } = await supabase.from('quimieats_ledger').insert({
                    restaurant_id: restaurantId,
                    amount: parseFloat(amount),
                    type: type,
                    status: 'settled',
                    customer_id: 'platform_admin',
                    order_id: description || null
                }).select().single();

                if (error) throw error;

                // 2. Fetch new balance to see if we should toggle merchant status
                const { data: allLedger } = await supabase.from('quimieats_ledger').select('amount').eq('restaurant_id', restaurantId);
                const newBalance = (allLedger || []).reduce((sum, l) => sum + parseFloat(l.amount), 0);

                // Auto toggle status if balance is above/below the credit limit threshold
                if (newBalance >= 0) {
                    await supabase.from('restaurants').update({ status: 'active' }).eq('id', restaurantId);
                } else if (newBalance < -100) {
                    await supabase.from('restaurants').update({ status: 'suspended' }).eq('id', restaurantId);
                }

                return res.json({ success: true, entry, balance: newBalance });
            } catch (e) {
                return res.status(500).json({ error: e.message });
            }
        }

        // --- COMMISSION TOPUPS (ADMIN REVIEW & APPROVAL) ---
        if (action === 'get_pending_topups' && req.method === 'GET') {
            if (!isAdmin) return res.status(403).json({ error: "Unauthorized" });
            try {
                const { data: topups, error } = await supabase.from('commission_topups')
                    .select('*')
                    .eq('status', 'pending')
                    .order('created_at', { ascending: false });

                if (error) {
                    return res.json({ success: true, topups: [] });
                }

                // Enrich with restaurant details
                const resIds = (topups || []).map(t => t.restaurant_id);
                let resMap = {};
                if (resIds.length > 0) {
                    const { data: resList } = await supabase.from('restaurants')
                        .select('id, name, logo_url, contact_phone')
                        .in('id', resIds);
                    (resList || []).forEach(r => { resMap[r.id] = r; });
                }

                const enriched = (topups || []).map(t => ({
                    ...t,
                    restaurant_name: resMap[t.restaurant_id]?.name || t.restaurant_id,
                    restaurant_logo: resMap[t.restaurant_id]?.logo_url || null,
                    restaurant_phone: resMap[t.restaurant_id]?.contact_phone || null
                }));

                return res.json({ success: true, topups: enriched });
            } catch (e) {
                return res.status(500).json({ error: e.message });
            }
        }

        if (action === 'approve_commission_topup' && req.method === 'POST') {
            if (!isAdmin) return res.status(403).json({ error: "Unauthorized" });
            const { topupId, restaurantId, amount, bankName, referenceNumber } = req.body || {};
            if (!topupId || !restaurantId || !amount) {
                return res.status(400).json({ error: "Missing parameters" });
            }

            try {
                // 1. Mark topup approved
                await supabase.from('commission_topups')
                    .update({
                        status: 'approved',
                        reviewed_at: new Date().toISOString(),
                        reviewed_by: 'admin'
                    })
                    .eq('id', topupId);

                // 2. Insert into ledger
                const desc = `Transferencia ${bankName || 'Banco'} ${referenceNumber ? '#' + referenceNumber : ''}`.trim();
                await supabase.from('quimieats_ledger').insert({
                    restaurant_id: restaurantId,
                    amount: parseFloat(amount),
                    type: 'topup',
                    status: 'settled',
                    customer_id: 'platform_admin',
                    order_id: desc
                });

                // 3. Reactivate restaurant if it was suspended
                const { data: allLedger } = await supabase.from('quimieats_ledger').select('amount').eq('restaurant_id', restaurantId);
                const newBalance = (allLedger || []).reduce((sum, l) => sum + parseFloat(l.amount), 0);

                if (newBalance >= 0) {
                    await supabase.from('restaurants').update({ status: 'active' }).eq('id', restaurantId);
                }

                return res.json({ success: true, message: "Recarga aprobada y saldo acreditado con éxito", newBalance });
            } catch (e) {
                return res.status(500).json({ error: e.message });
            }
        }

        if (action === 'reject_commission_topup' && req.method === 'POST') {
            if (!isAdmin) return res.status(403).json({ error: "Unauthorized" });
            const { topupId, reason } = req.body || {};
            if (!topupId) return res.status(400).json({ error: "topupId is required" });

            try {
                await supabase.from('commission_topups')
                    .update({
                        status: 'rejected',
                        notes: reason || 'Rechazado por administración',
                        reviewed_at: new Date().toISOString(),
                        reviewed_by: 'admin'
                    })
                    .eq('id', topupId);

                return res.json({ success: true, message: "Comprobante marcado como rechazado" });
            } catch (e) {
                return res.status(500).json({ error: e.message });
            }
        }

        // --- CUSTOMER & USER SUPPORT MANAGEMENT ---
        if (action === 'list_customers' && req.method === 'GET') {
            if (!isAdmin) return res.status(403).json({ error: "Unauthorized" });
            const query = (req.query.q || '').trim();
            try {
                let dbQuery = supabase.from('customers').select('*').order('created_at', { ascending: false }).limit(50);
                if (query) {
                    dbQuery = dbQuery.or(`name.ilike.%${query}%,phone.ilike.%${query}%`);
                }
                const { data, error } = await dbQuery;
                if (error) throw error;
                return res.json({ success: true, customers: data || [] });
            } catch (e) {
                return res.status(500).json({ error: e.message });
            }
        }

        if (action === 'update_customer' && req.method === 'POST') {
            if (!isAdmin) return res.status(403).json({ error: "Unauthorized" });
            const { id, name, phone, pin, rico_balance } = req.body || {};

            try {
                const updates = {};
                if (name !== undefined) updates.name = name;
                if (phone !== undefined) updates.phone = phone.replace(/\D/g, '');
                if (pin !== undefined) updates.pin = pin;
                if (rico_balance !== undefined) updates.rico_balance = parseFloat(rico_balance);

                let query = supabase.from('customers').update(updates);
                if (id) query = query.eq('id', id);
                else if (phone) query = query.eq('phone', phone.replace(/\D/g, ''));

                const { data, error } = await query.select().maybeSingle();

                if (error) throw error;
                return res.json({ success: true, customer: data, message: "Cliente actualizado con éxito" });
            } catch (e) {
                return res.status(500).json({ error: e.message });
            }
        }

        if (action === 'create_customer' && req.method === 'POST') {
            if (!isAdmin) return res.status(403).json({ error: "Unauthorized" });
            const { name, phone, pin, initial_balance } = req.body || {};
            if (!phone) return res.status(400).json({ error: "Teléfono es requerido" });

            try {
                const cleanPhone = phone.replace(/\D/g, '');
                const newId = 'cust_' + Date.now() + Math.floor(Math.random()*1000);
                const { data, error } = await supabase.from('customers')
                    .insert({
                        id: newId,
                        name: name || `Cliente ${cleanPhone.slice(-4)}`,
                        phone: cleanPhone,
                        pin: pin || '1234',
                        rico_balance: parseFloat(initial_balance) || 0,
                        points: 0
                    })
                    .select()
                    .single();

                if (error) throw error;
                return res.json({ success: true, customer: data, message: "Cliente registrado con éxito" });
            } catch (e) {
                return res.status(500).json({ error: e.message });
            }
        }

        // --- QUIMIEATS PARTNERS ---
        if (action === 'quimieats_active' && req.method === 'GET') {
            try {
                const [rRes, rLeads, rLedger] = await Promise.all([
                    supabase.from('restaurants').select('*'),
                    supabase.from('quimieats_leads').select('*'),
                    supabase.from('quimieats_ledger').select('restaurant_id, amount')
                ]);
                
                const restaurants = rRes.data || [];
                const leads = rLeads.data || [];
                const ledger = rLedger.data || [];

                // Calculate balances
                const balances = {};
                ledger.forEach(entry => {
                    if (!balances[entry.restaurant_id]) balances[entry.restaurant_id] = 0;
                    balances[entry.restaurant_id] += parseFloat(entry.amount);
                });

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
                    ...restaurants.map(r => {
                        const bal = balances[r.id] !== undefined ? balances[r.id] : 0;
                        const isSuspended = r.status === 'suspended' || r.status === 'inactive' || bal < -100;
                        
                        return {
                            id: r.id,
                            lead_id: null,
                            name: r.name,
                            logo_url: r.logo_url || '',
                            phone: r.contact_phone || '',
                            category: r.category || 'restaurante',
                            in_person_onboarding: r.settings?.in_person_onboarding || false,
                            plan: r.settings?.plan || 'trial',
                            status: isSuspended ? 'suspended' : r.status,
                            balance: bal
                        };
                    }),
                    ...leads.map(l => ({
                        id: 'lead_' + l.id,
                        lead_id: l.id,
                        name: l.restaurant_name,
                        logo_url: l.logo_url || '',
                        phone: l.phone || '',
                        category: l.category || 'restaurante',
                        in_person_onboarding: false,
                        plan: 'lead',
                        status: 'active',
                        balance: 0
                    }))
                ];

                // Map elite rules
                eliteRules.forEach(rule => {
                    const match = rawRecords.find(rec => rec.name.toLowerCase().includes(rule.match.toLowerCase()));
                    if (match && match.status === 'active') {
                        final.push({
                            id: rule.id,
                            lead_id: match.lead_id,
                            name: rule.name,
                            logo_url: match.logo_url,
                            contact_phone: match.phone,
                            category: match.category,
                            in_person_onboarding: match.in_person_onboarding || false,
                            plan: match.plan || 'trial',
                            balance: match.balance
                        });
                        seen.add(rule.id);
                        seen.add(match.id);
                    }
                });

                // 2. Append all other records dynamically
                rawRecords.forEach(rec => {
                    if (!seen.has(rec.id) && !seen.has('lead_' + rec.lead_id) && rec.name && rec.status === 'active') {
                        final.push({
                            id: rec.id,
                            lead_id: rec.lead_id,
                            name: rec.name,
                            logo_url: rec.logo_url,
                            contact_phone: rec.phone,
                            category: rec.category,
                            in_person_onboarding: rec.in_person_onboarding || false,
                            plan: rec.plan || 'trial',
                            balance: rec.balance
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
