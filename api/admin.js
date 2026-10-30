// api/admin.js
const { supabase } = require('./lib/supabase');
const { isMasterPin, isAdminCredential } = require('./lib/auth');
const { pinThrottleCheck, pinThrottleFail, pinThrottleSuccess } = require('./lib/rate-limit');
const ricoLoyalty = require('./lib/rico-loyalty');
const inventoryEngine = require('./lib/inventory-engine');

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
                        // Margin chip data (2026-10-29): per-item food cost =
                        // sum(recipe lines x inventory.cost_per_unit), one level
                        // deep -- preps carry their computed unit cost. Partial
                        // when any line's ingredient has no cost yet. Any failure
                        // here leaves the items untouched (menu load never breaks).
                        try {
                            const itemIds = rItems.data.map(i => i.id);
                            const [rLines, rInv] = await Promise.all([
                                supabase.from('menu_item_ingredients').select('menu_item_id, inventory_item_id, quantity').in('menu_item_id', itemIds),
                                supabase.from('inventory').select('id, cost_per_unit')
                            ]);
                            const costOf = {};
                            (rInv.data || []).forEach(r => { costOf[r.id] = (r.cost_per_unit === null || r.cost_per_unit === undefined) ? null : parseFloat(r.cost_per_unit); });
                            const byItem = {};
                            (rLines.data || []).forEach(l => { (byItem[l.menu_item_id] = byItem[l.menu_item_id] || []).push(l); });
                            rItems.data.forEach(it => {
                                const lines = byItem[it.id] || [];
                                it.has_recipe = lines.length > 0;
                                let sum = 0, priced = 0, unpriced = 0;
                                lines.forEach(l => {
                                    const c = costOf[l.inventory_item_id];
                                    if (c === null || c === undefined) { unpriced++; }
                                    else { sum += parseFloat(l.quantity || 0) * c; priced++; }
                                });
                                it.food_cost = priced > 0 ? Math.round(sum * 100) / 100 : null;
                                it.suggested = priced > 0 ? Math.round((sum / 0.30) / 5) * 5 : null;
                                it.cost_partial = unpriced > 0;
                            });
                        } catch(costErr) {
                            console.warn("[admin.js] margin cost attach failed:", costErr.message);
                        }
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

        // --- MENU SELF-SERVE (2026-10-30): line flags + Extras sync ------
        // flag vocabulary on menu_item_ingredients. In /admin the owner
        // reads "Fijo / Se puede quitar / Se puede agregar"; the stored
        // values stay short: fijo | removible | agregable.
        const FLAG_VALUES = ['fijo', 'removible', 'agregable'];
        const normFlag = (v) => FLAG_VALUES.includes(String(v || '').toLowerCase()) ? String(v).toLowerCase() : 'fijo';

        // uuid5 identical to the seed generators (gen_espresso_seed.py's
        // namespace), so an id minted here and an id minted by a seed agree.
        const FLAG_UUID_NS = '7a4c1d2e-0000-5000-8000-0000000000e5';
        const uuid5 = (name) => {
            const crypto = require('crypto');
            const nsBytes = Buffer.from(FLAG_UUID_NS.replace(/-/g, ''), 'hex');
            const hash = crypto.createHash('sha1').update(nsBytes).update(String(name), 'utf8').digest();
            const b = Buffer.from(hash.subarray(0, 16));
            b[6] = (b[6] & 0x0f) | 0x50;
            b[8] = (b[8] & 0x3f) | 0x80;
            const h = b.toString('hex');
            return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
        };
        const flagExtraOptionId = (menuItemId, invSlug) => uuid5('option:flag-extra:' + menuItemId + ':' + invSlug);
        const flagExtraDeltaId = (menuItemId, invSlug, qty) =>
            'mi-flag-extra-' + menuItemId + '-' + invSlug + ((parseFloat(qty) || 0) < 0 ? '-neg' : '-pos');

        // An "agregable" line is also sold as an option in the item's
        // Extras group; this keeps that option and its delta row (seed
        // modifier_ingredients shape) in sync with the line. The engine
        // SUMS an option's global (item_id NULL) and per-item delta rows,
        // so: a generated option (no global rows) carries the full line
        // quantity on its item row; a SHARED seeded option (same kitchen
        // name, e.g. Huevo) keeps its price untouched — it prices every
        // item at once — and the item row carries only the difference
        // between the line quantity and the global rows' sum.
        async function syncFlagExtra({ restaurantId, menuItemId, invId, flag, extraPrice, quantity, unit }) {
            try {
                const { data: inv } = await supabase.from('inventory').select('id, name, slug, unit').eq('id', invId).maybeSingle();
                if (!inv) return null;
                const invSlug = inv.slug || inv.id;
                const invUnit = unit || inv.unit || '';
                const genId = flagExtraOptionId(menuItemId, invSlug);
                if (flag !== 'agregable') {
                    // Un-flagged (or line deleted): remove what the flag
                    // created. A generated option dies whole — its delta
                    // rows cascade. A shared option only loses the two
                    // possible flag delta rows for this item.
                    const { data: gen } = await supabase.from('modifier_options').select('id').eq('id', genId).maybeSingle();
                    if (gen) await supabase.from('modifier_options').delete().eq('id', genId);
                    await supabase.from('modifier_ingredients').delete().eq('id', flagExtraDeltaId(menuItemId, invSlug, 1));
                    await supabase.from('modifier_ingredients').delete().eq('id', flagExtraDeltaId(menuItemId, invSlug, -1));
                    return { action: 'removed' };
                }
                const { data: groups } = await supabase.from('modifier_groups').select('id, name').eq('restaurant_id', restaurantId);
                let extras = (groups || []).find(g => String(g.name || '').trim().toLowerCase() === 'extras');
                if (!extras) {
                    const { data: g, error: gErr } = await supabase.from('modifier_groups')
                        .insert({ name: 'Extras', required: false, max_selections: 3, restaurant_id: restaurantId }).select().single();
                    if (gErr || !g) return null;
                    extras = g;
                }
                const { data: link } = await supabase.from('item_modifier_groups').select('item_id')
                    .eq('item_id', menuItemId).eq('group_id', extras.id).maybeSingle();
                if (!link) {
                    await supabase.from('item_modifier_groups').insert({ item_id: menuItemId, group_id: extras.id, display_order: 90 });
                }
                const lineQty = Math.abs(parseFloat(quantity) || 0);
                const { data: sameName } = await supabase.from('modifier_options').select('id, price_adjustment')
                    .eq('group_id', extras.id).eq('name', inv.name).maybeSingle();
                if (sameName && sameName.id !== genId) {
                    // Shared seeded option: hang a compensating item row on
                    // it so global + item sum to exactly the line quantity.
                    const { data: globals } = await supabase.from('modifier_ingredients')
                        .select('quantity').eq('modifier_option_id', sameName.id).is('item_id', null).eq('inventory_item_id', invSlug).eq('unit', invUnit);
                    const globalSum = (globals || []).reduce((s, r) => s + (parseFloat(r.quantity) || 0), 0);
                    const diff = Math.round((lineQty - globalSum) * 10000) / 10000;
                    await supabase.from('modifier_ingredients').delete().eq('id', flagExtraDeltaId(menuItemId, invSlug, 1));
                    await supabase.from('modifier_ingredients').delete().eq('id', flagExtraDeltaId(menuItemId, invSlug, -1));
                    if (diff !== 0) {
                        await supabase.from('modifier_ingredients').insert({
                            id: flagExtraDeltaId(menuItemId, invSlug, diff), modifier_option_id: sameName.id,
                            item_id: menuItemId, inventory_item_id: invSlug, quantity: diff, unit: invUnit
                        });
                    }
                    return { action: 'upserted', option_id: sameName.id, name: inv.name, price_adjustment: parseFloat(sameName.price_adjustment) || 0, shared: true };
                }
                const price = (extraPrice === null || extraPrice === undefined || isNaN(extraPrice)) ? 0 : extraPrice;
                await supabase.from('modifier_options').upsert({
                    id: genId, group_id: extras.id, name: inv.name,
                    price_adjustment: price, is_default: false, allow_qty: false, default_qty: null
                }, { onConflict: 'id' });
                await supabase.from('modifier_ingredients').delete().eq('id', flagExtraDeltaId(menuItemId, invSlug, -1));
                await supabase.from('modifier_ingredients').upsert({
                    id: flagExtraDeltaId(menuItemId, invSlug, 1), modifier_option_id: genId,
                    item_id: menuItemId, inventory_item_id: invSlug, quantity: lineQty, unit: invUnit
                }, { onConflict: 'id' });
                return { action: 'upserted', option_id: genId, name: inv.name, price_adjustment: price, shared: false };
            } catch (e) {
                console.warn('[flags] syncFlagExtra failed:', e.message);
                return { action: 'error', error: e.message };
            }
        }

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
                    flag: normFlag(r.flag),
                    extra_price: (r.extra_price === undefined || r.extra_price === null) ? null : parseFloat(r.extra_price),
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
            // Self-serve flags (2026-10-30): only written when the caller
            // sends them, so older saves keep behaving exactly as before.
            const flagTouched = b.flag !== undefined;
            const flag = normFlag(b.flag);
            let extraPrice = null;
            if (b.extra_price !== undefined && b.extra_price !== null && b.extra_price !== '') {
                const ep = parseFloat(b.extra_price);
                if (!isNaN(ep)) extraPrice = ep;
            }
            const row = {
                menu_item_id: menuItemId,
                inventory_item_id: invId,
                quantity: parseFloat(qtyRaw) || 0,
                unit
            };
            if (stepNo !== null) row.step_no = stepNo;
            if (flagTouched) {
                row.flag = flag;
                if (b.extra_price !== undefined) row.extra_price = extraPrice;
            }
            let attempt = { ...row };
            let { data, error } = await supabase.from('menu_item_ingredients')
                .upsert(attempt, { onConflict: 'menu_item_id,inventory_item_id' }).select().single();
            if (error && (attempt.flag !== undefined || attempt.extra_price !== undefined)) {
                // Pre-migration DB (no flag/extra_price columns yet): keep
                // the line, drop the new fields rather than failing the save.
                const { flag: _f, extra_price: _p, ...noFlag } = attempt;
                attempt = noFlag;
                ({ data, error } = await supabase.from('menu_item_ingredients')
                    .upsert(attempt, { onConflict: 'menu_item_id,inventory_item_id' }).select().single());
            }
            if (error && attempt.step_no !== undefined) {
                // Pre-migration DB (no step_no column yet): keep the link,
                // drop the step tie rather than failing the save.
                const { step_no: _drop, ...rowNoStep } = attempt;
                attempt = rowNoStep;
                ({ data, error } = await supabase.from('menu_item_ingredients')
                    .upsert(attempt, { onConflict: 'menu_item_id,inventory_item_id' }).select().single());
            }
            if (error) return res.status(500).json({ error: error.message });
            let extra = null;
            if (flagTouched) {
                extra = await syncFlagExtra({ restaurantId: currentResId, menuItemId, invId, flag, extraPrice, quantity: row.quantity, unit });
            }
            return res.json({ success: true, data, extra });
        }

        if (action === 'menu_item_ingredient_delete' && req.method === 'DELETE') {
            if (!isAdmin) return res.status(403).json({ error: "Unauthorized" });
            const rowId = id || req.query.id;
            if (!rowId) return res.status(400).json({ error: "Missing ingredient link ID" });
            // Read the line first: if it was "agregable", its Extras option
            // (or its row on a shared option) must go with it.
            const { data: lineRow } = await supabase.from('menu_item_ingredients')
                .select('menu_item_id, inventory_item_id, unit').eq('id', rowId).maybeSingle();
            const { error } = await supabase.from('menu_item_ingredients').delete().eq('id', rowId);
            if (error) return res.status(500).json({ error: error.message });
            if (lineRow && lineRow.menu_item_id && lineRow.inventory_item_id) {
                await syncFlagExtra({
                    restaurantId: currentResId, menuItemId: lineRow.menu_item_id,
                    invId: lineRow.inventory_item_id, flag: 'fijo', extraPrice: null,
                    quantity: 0, unit: lineRow.unit || ''
                });
            }
            return res.json({ success: true });
        }

        // --- OPTION DELTAS ("Qué cambia en la receta") -------------------
        // The editor behind SELF-SERVE-GAPS wall #2: an option's rows in
        // modifier_ingredients, written from /admin instead of SQL seeds.
        // Row shape is the seed's: id 'mi-<opción>-<producto|all>-<insumo>-
        // pos|neg', inventory_item_id = the catalog SLUG, signed quantity,
        // the insumo's own unit. The KDS engine SUMS global (item_id NULL)
        // and per-item rows for an option — the editor shows and costs
        // that same sum, so what the owner reads is what the kitchen gets.
        if (action === 'option_deltas' && req.method === 'GET') {
            if (!isAdmin) return res.status(403).json({ error: "Unauthorized" });
            const optionId = id || req.query.option_id || req.query.id;
            if (!optionId) return res.status(400).json({ error: "Missing option ID" });
            const { data: opt } = await supabase.from('modifier_options').select('id, group_id, name, price_adjustment').eq('id', optionId).maybeSingle();
            if (!opt) return res.status(404).json({ error: "Option not found" });
            const [{ data: grp }, { data: links }, { data: deltas }, { data: invAll }] = await Promise.all([
                supabase.from('modifier_groups').select('id, name').eq('id', opt.group_id).maybeSingle(),
                supabase.from('item_modifier_groups').select('item_id').eq('group_id', opt.group_id),
                supabase.from('modifier_ingredients').select('id, item_id, inventory_item_id, quantity, unit').eq('modifier_option_id', optionId),
                supabase.from('inventory').select('id, name, slug, unit')
            ]);
            const itemIds = [...new Set((links || []).map(l => l.item_id).filter(Boolean))];
            let items = [];
            if (itemIds.length) {
                const { data: mi } = await supabase.from('menu_items').select('id, name, price').in('id', itemIds).order('name');
                items = mi || [];
            }
            const invByKey = {};
            (invAll || []).forEach(v => { if (v.id) invByKey[v.id] = v; if (v.slug) invByKey[v.slug] = v; });
            const outDeltas = (deltas || []).map(d => {
                const inv = invByKey[d.inventory_item_id] || {};
                return {
                    id: d.id,
                    item_id: d.item_id || null,
                    inventory_item_id: d.inventory_item_id,
                    inv_name: inv.name || d.inventory_item_id,
                    inv_id: inv.id || null,
                    quantity: parseFloat(d.quantity) || 0,
                    unit: d.unit || inv.unit || ''
                };
            });
            return res.json({
                success: true,
                option: { id: opt.id, name: opt.name, group_id: opt.group_id, group_name: grp?.name || '', price_adjustment: parseFloat(opt.price_adjustment) || 0 },
                items,
                deltas: outDeltas
            });
        }

        if (action === 'option_deltas_save' && req.method === 'POST') {
            if (!isAdmin) return res.status(403).json({ error: "Unauthorized" });
            const b = req.body || {};
            const optionId = b.option_id;
            const scopeItem = (b.item_id === undefined || b.item_id === null || b.item_id === '') ? null : String(b.item_id);
            const acceptHigh = b.accept_high_cogs === true;
            if (!optionId) return res.status(400).json({ error: "Missing option_id" });
            const { data: opt } = await supabase.from('modifier_options').select('id, group_id, name').eq('id', optionId).maybeSingle();
            if (!opt) return res.status(404).json({ error: "Option not found" });

            // Catalog: resolve each requested insumo by id or slug; rows
            // are always STORED by slug, in the insumo's own unit.
            const { data: invAll } = await supabase.from('inventory').select('id, name, slug, unit, cost_per_unit');
            const invByKey = {};
            (invAll || []).forEach(v => { if (v.id) invByKey[v.id] = v; if (v.slug) invByKey[v.slug] = v; });
            const want = [];
            const seenInv = new Set();
            for (const r of (Array.isArray(b.rows) ? b.rows : [])) {
                const inv = invByKey[r.inventory_item_id] || invByKey[r.inv_slug];
                const qty = parseFloat(r.quantity);
                if (!inv || isNaN(qty) || qty === 0) continue;
                const slug = inv.slug || inv.id;
                if (seenInv.has(slug)) continue;
                seenInv.add(slug);
                want.push({ inv, slug, quantity: qty, unit: inv.unit || r.unit || '' });
            }

            // Carrying items + their base recipes (for the guardrails).
            const { data: links } = await supabase.from('item_modifier_groups').select('item_id').eq('group_id', opt.group_id);
            const itemIds = [...new Set((links || []).map(l => l.item_id).filter(Boolean))];
            const { data: menuRows } = itemIds.length
                ? await supabase.from('menu_items').select('id, name, price').in('id', itemIds)
                : { data: [] };
            const itemById = {};
            (menuRows || []).forEach(m => { itemById[m.id] = m; });
            const affectedIds = scopeItem ? [scopeItem] : itemIds;
            let baseByItem = {};
            if (affectedIds.length) {
                const { data: lines } = await supabase.from('menu_item_ingredients')
                    .select('menu_item_id, inventory_item_id, quantity, unit').in('menu_item_id', affectedIds);
                (lines || []).forEach(l => { (baseByItem[l.menu_item_id] = baseByItem[l.menu_item_id] || []).push(l); });
            }
            // Existing rows of THIS option outside the edited scope stay;
            // the effective per-item effect is global + item (engine sum).
            const { data: existRows } = await supabase.from('modifier_ingredients')
                .select('id, item_id, inventory_item_id, quantity, unit').eq('modifier_option_id', optionId);
            const otherScope = (existRows || []).filter(d => (d.item_id || null) !== scopeItem);
            const effectiveFor = (itemId) => {
                const eff = {};
                otherScope.filter(d => d.item_id === null || d.item_id === itemId)
                    .forEach(d => { eff[d.inventory_item_id] = (eff[d.inventory_item_id] || 0) + (parseFloat(d.quantity) || 0); });
                if (scopeItem === null || scopeItem === itemId) {
                    want.forEach(w => { eff[w.slug] = (eff[w.slug] || 0) + w.quantity; });
                }
                return eff;
            };

            // Guardrail 1 (brief): a "quita" may not exceed what the
            // recipe carries. Blocked with the plain reason, never warned.
            for (const itemId of affectedIds) {
                const eff = effectiveFor(itemId);
                const base = baseByItem[itemId] || [];
                for (const slug of Object.keys(eff)) {
                    if (eff[slug] >= 0) continue;
                    const inv = invByKey[slug];
                    const line = inv ? base.find(l => l.inventory_item_id === inv.id) : null;
                    if (!line) continue; // nothing to remove from — no-op there
                    if (Math.abs(eff[slug]) > (parseFloat(line.quantity) || 0)) {
                        return res.json({
                            success: false, blocked: true,
                            reason: `La receta de ${itemById[itemId]?.name || itemId} solo lleva ${line.quantity} ${line.unit || ''} de ${inv.name}. No se puede quitar ${Math.abs(eff[slug])}. Quitá menos, o hacé el cambio solo para ese producto.`
                        });
                    }
                }
            }
            if (scopeItem === null) {
                for (const w of want) {
                    if (w.quantity >= 0) continue;
                    const anyLine = affectedIds.some(itemId => (baseByItem[itemId] || []).some(l => l.inventory_item_id === w.inv.id));
                    if (affectedIds.length && !anyLine) {
                        return res.json({
                            success: false, blocked: true,
                            reason: `Ningún producto con la opción ${opt.name} lleva ${w.inv.name} en su receta. No hay nada que quitar.`
                        });
                    }
                }
            }

            // Guardrail 2 (brief): the new costo/COGS per affected item,
            // margin-chip math (one level: lines x cost_per_unit, deltas
            // summed the way the kitchen sums them). Past 35% needs the
            // owner's explicit "lo acepto a sabiendas" — never auto-saved.
            const costOf = (inv) => (inv && inv.cost_per_unit !== null && inv.cost_per_unit !== undefined) ? parseFloat(inv.cost_per_unit) : null;
            const costRows = affectedIds.map(itemId => {
                let sum = 0, partial = false;
                (baseByItem[itemId] || []).forEach(l => {
                    const c = costOf(invByKey[l.inventory_item_id]);
                    if (c === null) partial = true; else sum += (parseFloat(l.quantity) || 0) * c;
                });
                const eff = effectiveFor(itemId);
                Object.keys(eff).forEach(slug => {
                    const c = costOf(invByKey[slug]);
                    if (c === null) partial = true; else sum += eff[slug] * c;
                });
                const costo = Math.round(sum * 100) / 100;
                const price = parseFloat(itemById[itemId]?.price) || 0;
                return {
                    item_id: itemId,
                    name: itemById[itemId]?.name || itemId,
                    costo,
                    cogs_pct: price > 0 ? Math.round((costo / price) * 1000) / 10 : null,
                    sugerido: Math.round((sum / 0.30) / 5) * 5,
                    partial
                };
            });
            const over = costRows.filter(c => c.cogs_pct !== null && c.cogs_pct > 35);
            if (over.length && !acceptHigh) {
                return res.json({ success: false, needs_accept: true, costs: costRows, over });
            }

            // Write: replace this scope's rows, seed-format ids. If a
            // computed id is already taken by ANOTHER option's row (two
            // options sharing a name), suffix the option's short id so
            // the write stays deterministic instead of clobbering it.
            {
                let del = supabase.from('modifier_ingredients').delete().eq('modifier_option_id', optionId);
                del = scopeItem === null ? del.is('item_id', null) : del.eq('item_id', scopeItem);
                const { error: delErr } = await del;
                if (delErr) return res.status(500).json({ error: delErr.message });
            }
            const optSlug = slugifyInv(opt.name) || 'opcion';
            const scopeTag = scopeItem || 'all';
            for (const w of want) {
                let rowId = `mi-${optSlug}-${scopeTag}-${w.slug}-${w.quantity < 0 ? 'neg' : 'pos'}`;
                const { data: clash } = await supabase.from('modifier_ingredients').select('modifier_option_id').eq('id', rowId).maybeSingle();
                if (clash && clash.modifier_option_id !== optionId) rowId = rowId + '-' + String(optionId).slice(0, 8);
                const { error: insErr } = await supabase.from('modifier_ingredients').insert({
                    id: rowId, modifier_option_id: optionId, item_id: scopeItem,
                    inventory_item_id: w.slug, quantity: w.quantity, unit: w.unit
                });
                if (insErr) return res.status(500).json({ error: insErr.message });
            }

            const quita = want.filter(w => w.quantity < 0).map(w => `${w.inv.name} ${Math.abs(w.quantity)} ${w.unit}`);
            const pone = want.filter(w => w.quantity > 0).map(w => `${w.inv.name} ${w.quantity} ${w.unit}`);
            const ambito = scopeItem ? (itemById[scopeItem]?.name || scopeItem) : 'todos los productos con esta opción';
            const parts = [];
            if (quita.length) parts.push('quita ' + quita.join(', '));
            if (pone.length) parts.push('pone ' + pone.join(', '));
            const summary = parts.length
                ? `${opt.name} en ${ambito} ahora ${parts.join(' y ')}.`
                : `${opt.name} en ${ambito} ya no cambia la receta.`;
            return res.json({ success: true, summary, costs: costRows });
        }

        // --- INVENTORY OPS (2026-10-30, inventory core) ----------------
        // Receiving (§7k), Producción (§7g/§7i), the count walk (§7c)
        // and the Bitácora (§7h) — the engine lives in
        // api/lib/inventory-engine.js; these actions are its front
        // door. Actors per ROLES-AND-VIEWS: Encargado + Barista/
        // Cocinero receive, produce, move and count (attributed);
        // the Cajero's only inventory right is reporting a shortage
        // (inventory_alert). Financial readouts (drift) stay on the
        // isAdmin gate like the margin chip; the piece-6 role build
        // tightens them to Owner. The role strings in `employees`
        // predate the four-role naming ('admin' = Encargado here), so
        // the sets accept both vocabularies.
        const invActor = async () => {
            const cred = (authHeader || '').replace(/^Bearer\s+/i, '').trim();
            if (!cred) return null;
            if (isAdminCredential(cred)) return { id: 'master', name: 'Admin', role: 'owner' };
            try {
                const { data } = await supabase.from('employees')
                    .select('id, name, role').eq('pin', cred).eq('active', true).maybeSingle();
                if (data) return { id: data.id, name: data.name, role: String(data.role || '').toLowerCase().trim() };
            } catch (e) { /* fall through */ }
            return null;
        };
        const OPS_ROLES = ['admin', 'encargado', 'barista', 'cocinero', 'cook', 'chef', 'barra', 'cocina', 'barista/cocinero'];
        const canOps = (a) => !!a && (a.role === 'owner' || OPS_ROLES.includes(a.role));
        const canCatalog = (a) => !!a && (a.role === 'owner' || a.role === 'admin' || a.role === 'encargado');
        const invFail = (res, e) => {
            if (e && e.code) return res.status(422).json({ error: e.code, message: e.message });
            return res.status(500).json({ error: (e && e.message) || 'Error' });
        };

        if (action === 'inventory_presentaciones' && req.method === 'GET') {
            const actor = await invActor();
            if (!canOps(actor)) return res.status(403).json({ error: "Unauthorized" });
            let q = supabase.from('presentaciones').select('*').eq('active', true).order('descripcion');
            if (req.query.insumo) q = q.eq('inventory_item_id', req.query.insumo);
            const { data, error } = await q;
            if (error) return res.status(500).json({ error: error.message });
            return res.json(data || []);
        }

        if (action === 'inventory_barcode' && req.method === 'GET') {
            const actor = await invActor();
            if (!canOps(actor)) return res.status(403).json({ error: "Unauthorized" });
            const code = String(req.query.code || '').trim();
            if (!code) return res.status(400).json({ error: "Missing barcode" });
            const { data } = await supabase.from('presentaciones').select('*')
                .eq('barcode', code).eq('active', true).maybeSingle();
            if (!data) return res.json({ found: false });
            const { data: insumo } = await supabase.from('inventory')
                .select('id, name, unit').eq('id', data.inventory_item_id).maybeSingle();
            return res.json({ found: true, presentacion: data, insumo });
        }

        if (action === 'presentacion_save' && req.method === 'POST') {
            const actor = await invActor();
            const b = req.body || {};
            const isDraftCreate = !b.id && b.is_draft === true;
            if (!canCatalog(actor) && !(isDraftCreate && canOps(actor))) {
                return res.status(403).json({ error: "Unauthorized" });
            }
            if (!b.inventory_item_id || !String(b.descripcion || '').trim()) {
                return res.status(400).json({ error: "Falta el insumo o la descripción de la presentación" });
            }
            const unidades = parseFloat(b.unidades_por_paquete) || 1;
            const porUnidad = parseFloat(b.contenido_por_unidad) || 0;
            const total = b.contenido_total !== undefined && b.contenido_total !== null && b.contenido_total !== ''
                ? parseFloat(b.contenido_total) : unidades * porUnidad;
            if (!(total > 0)) return res.status(400).json({ error: "La presentación debe decir cuánto trae en total" });
            const row = {
                inventory_item_id: String(b.inventory_item_id),
                descripcion: String(b.descripcion).trim(),
                marca: b.marca ? String(b.marca) : null,
                proveedor: b.proveedor ? String(b.proveedor) : null,
                unidades_por_paquete: unidades,
                contenido_por_unidad: porUnidad || total,
                contenido_total: total,
                barcode: b.barcode ? String(b.barcode).trim() : null,
                factura_alias: b.factura_alias ? String(b.factura_alias) : null,
                photo_url: b.photo_url ? String(b.photo_url) : null,
                is_draft: !!b.is_draft
            };
            if (b.id) {
                const { data, error } = await supabase.from('presentaciones')
                    .update(row).eq('id', String(b.id)).select().single();
                if (error) return res.status(500).json({ error: error.message });
                return res.json({ success: true, data });
            }
            row.id = 'pres-' + slugifyInv(row.descripcion + ' ' + row.inventory_item_id) + '-' + Math.random().toString(36).slice(2, 6);
            row.restaurant_id = currentResId;
            const { data, error } = await supabase.from('presentaciones').insert(row).select().single();
            if (error) return res.status(500).json({ error: error.message });
            return res.json({ success: true, data });
        }

        if (action === 'presentacion_delete' && req.method === 'POST') {
            const actor = await invActor();
            if (!canCatalog(actor)) return res.status(403).json({ error: "Unauthorized" });
            const presId = (req.body && req.body.id) || id;
            if (!presId) return res.status(400).json({ error: "Missing presentación id" });
            const { error } = await supabase.from('presentaciones')
                .update({ active: false }).eq('id', String(presId));
            if (error) return res.status(500).json({ error: error.message });
            return res.json({ success: true });
        }

        if (action === 'produccion_state' && req.method === 'GET') {
            const actor = await invActor();
            if (!canOps(actor)) return res.status(403).json({ error: "Unauthorized" });
            const [{ data: inv }, { data: recipes }, { data: rLines }, { data: flags }, { data: lots }, { data: events }] = await Promise.all([
                supabase.from('inventory').select('id, name, slug, unit, category, kind, current_stock, min_stock, shelf_life_fresh_days, shelf_life_frozen_days'),
                supabase.from('prep_recipes').select('*'),
                supabase.from('prep_recipe_lines').select('*'),
                supabase.from('prep_flags').select('*').eq('status', 'open').order('created_at'),
                supabase.from('stock_lots').select('inventory_item_id, state, qty_left, expires_at').gt('qty_left', 0),
                supabase.from('inv_events').select('*').order('created_at', { ascending: false }).limit(30)
            ]);
            const invBySlug = {}; const invById = {};
            (inv || []).forEach(r => { if (r.slug) invBySlug[r.slug] = r; invById[r.id] = r; });
            const statesByItem = {};
            (lots || []).forEach(l => {
                const m = (statesByItem[l.inventory_item_id] = statesByItem[l.inventory_item_id] || {});
                m[l.state] = Math.round(((m[l.state] || 0) + parseFloat(l.qty_left || 0)) * 10000) / 10000;
            });
            const linesByPrep = {};
            (rLines || []).forEach(l => { (linesByPrep[l.prep_slug] = linesByPrep[l.prep_slug] || []).push(l); });
            const flagsByPrep = {};
            (flags || []).forEach(f => { (flagsByPrep[f.prep_slug] = flagsByPrep[f.prep_slug] || []).push(f); });
            const light = (stock, par) => {
                if (!par || par <= 0) return stock <= 0 ? 'rojo' : 'verde';
                if (stock <= 0 || stock <= par * 0.25) return 'rojo';
                if (stock < par) return 'amarillo';
                return 'verde';
            };
            const cards = [];
            (recipes || []).forEach(r => {
                const row = invBySlug[r.prep_slug];
                if (!row) return;
                cards.push({
                    type: 'prep', id: row.id, slug: r.prep_slug, name: row.name, unit: row.unit,
                    stock: parseFloat(row.current_stock || 0), par: parseFloat(row.min_stock || 0),
                    light: light(parseFloat(row.current_stock || 0), parseFloat(row.min_stock || 0)),
                    states: statesByItem[row.id] || {},
                    yield_qty: parseFloat(r.yield_qty || 0), yield_unit: r.yield_unit || row.unit,
                    flags: flagsByPrep[r.prep_slug] || [],
                    lines: (linesByPrep[r.prep_slug] || []).map(l => ({
                        name: invBySlug[l.ingredient_slug] ? invBySlug[l.ingredient_slug].name : l.ingredient_slug,
                        qty: parseFloat(l.quantity || 0), unit: l.unit,
                        stock: invBySlug[l.ingredient_slug] ? parseFloat(invBySlug[l.ingredient_slug].current_stock || 0) : null
                    }))
                });
            });
            (inv || []).filter(r => (r.kind || '') !== 'prep' && parseFloat(r.min_stock || 0) > 0).forEach(r => {
                cards.push({
                    type: 'raw', id: r.id, slug: r.slug, name: r.name, unit: r.unit,
                    stock: parseFloat(r.current_stock || 0), par: parseFloat(r.min_stock || 0),
                    light: light(parseFloat(r.current_stock || 0), parseFloat(r.min_stock || 0)),
                    states: statesByItem[r.id] || {}, flags: []
                });
            });
            const rank = { rojo: 0, amarillo: 1, verde: 2 };
            cards.sort((a, b) => ((b.flags.length > 0) - (a.flags.length > 0)) || (rank[a.light] - rank[b.light]) || a.name.localeCompare(b.name));
            // §7h inferred batches: a prep sold past its cooked stock
            // implies a batch nobody tapped. PROPOSED, never posted —
            // the cook confirms with the normal Producir flow.
            const proposals = cards.filter(c => c.type === 'prep' && c.stock < 0)
                .map(c => ({ prep_slug: c.slug, name: c.name, unit: c.unit, overdraft: Math.abs(c.stock) }));
            const tidyEvents = (events || []).filter(e => e.kind === 'tidy');
            const lastTidy = tidyEvents.length ? tidyEvents[0].created_at : null;
            let tidyDue = false;
            try {
                const hourFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Tegucigalpa', hour: 'numeric', hour12: false });
                const hour = parseInt(hourFmt.format(new Date()), 10);
                const open = hour >= 7 && hour < 19;
                tidyDue = open && (!lastTidy || (Date.now() - new Date(lastTidy).getTime()) > 55 * 60000);
            } catch (e) { tidyDue = false; }
            const pendingAlerts = (events || []).filter(e => e.kind === 'alert' && e.delivered === false).length;
            return res.json({
                cards, flags: flags || [], proposals,
                tidy: { last: lastTidy, due: tidyDue },
                pending_alerts: pendingAlerts
            });
        }

        if (action === 'inventory_movements' && req.method === 'GET') {
            const actor = await invActor();
            if (!canOps(actor)) return res.status(403).json({ error: "Unauthorized" });
            const [{ data: movements }, { data: events }] = await Promise.all([
                supabase.from('stock_movements').select('*').order('created_at', { ascending: false }).limit(120),
                supabase.from('inv_events').select('*').order('created_at', { ascending: false }).limit(60)
            ]);
            return res.json({ movements: movements || [], events: events || [] });
        }

        if (action === 'inventory_drift' && req.method === 'GET') {
            if (!isAdmin) return res.status(403).json({ error: "Unauthorized" });
            const since = new Date(Date.now() - 30 * 86400000).toISOString();
            const [{ data: drift }, { data: batches }] = await Promise.all([
                supabase.from('inventory_drift_flags').select('*').eq('status', 'open').order('created_at', { ascending: false }).limit(50),
                supabase.from('intake_batches').select('con_factura, total').gte('created_at', since)
            ]);
            const all = batches || [];
            const sin = all.filter(b => !b.con_factura);
            const totAll = all.reduce((s, b) => s + parseFloat(b.total || 0), 0);
            const totSin = sin.reduce((s, b) => s + parseFloat(b.total || 0), 0);
            return res.json({
                drift: drift || [],
                sin_factura: {
                    compras: all.length, sin_factura: sin.length,
                    pct_monto: totAll > 0 ? Math.round(totSin / totAll * 1000) / 10 : 0
                }
            });
        }

        if (action === 'inventory_intake_preview' && req.method === 'POST') {
            const actor = await invActor();
            if (!canOps(actor)) return res.status(403).json({ error: "Unauthorized" });
            try {
                const preview = await inventoryEngine.previewIntake(supabase, req.body || {});
                return res.json({ success: true, preview });
            } catch (e) { return invFail(res, e); }
        }

        if (action === 'inventory_factura_read' && req.method === 'POST') {
            const actor = await invActor();
            if (!canOps(actor)) return res.status(403).json({ error: "Unauthorized" });
            // STUB HONESTO (§7k): la lectura automática de la foto con
            // IA todavía no está conectada — este endpoint NO inventa
            // líneas. La foto se guarda como constancia con la
            // recepción y las tarjetas se cargan a mano (o escaneando
            // cada producto); cuando el lector se conecte acá, sus
            // líneas entrarán por el mismo papelQty del cross-check.
            return res.json({
                success: true, supported: false, lines: [],
                message: 'La lectura automática de la factura todavía no está activa. Cargá las tarjetas a mano: la foto igual queda guardada como constancia.'
            });
        }

        if (action === 'inventory_intake' && req.method === 'POST') {
            const actor = await invActor();
            if (!canOps(actor)) return res.status(403).json({ error: "Unauthorized" });
            const b = req.body || {};
            try {
                const input = { ...b, restaurantId: currentResId, actor };
                if (!b.conFactura) {
                    // §7k.2: el toque es DEL encargado, en su sesión,
                    // con motivo — nadie cierra sin factura por otro.
                    if (!canCatalog(actor) || b.confirm_override !== true) {
                        return res.status(403).json({
                            error: 'SIN_FACTURA_SIN_OVERRIDE',
                            message: 'Compra sin factura: la cierra el encargado con su toque y el motivo (ej: compra en el mercado).'
                        });
                    }
                    input.override = { by: actor.id, byName: actor.name, reason: b.override_reason };
                }
                const result = await inventoryEngine.postIntake(supabase, input);
                return res.json({ success: true, ...result });
            } catch (e) { return invFail(res, e); }
        }

        if (action === 'inventory_produce' && req.method === 'POST') {
            const actor = await invActor();
            if (!canOps(actor)) return res.status(403).json({ error: "Unauthorized" });
            try {
                const result = await inventoryEngine.produceBatch(supabase, { ...(req.body || {}), restaurantId: currentResId, actor });
                return res.json({ success: true, ...result });
            } catch (e) { return invFail(res, e); }
        }

        if (action === 'inventory_move' && req.method === 'POST') {
            const actor = await invActor();
            if (!canOps(actor)) return res.status(403).json({ error: "Unauthorized" });
            try {
                const result = await inventoryEngine.moveStock(supabase, { ...(req.body || {}), restaurantId: currentResId, actor });
                return res.json({ success: true, ...result });
            } catch (e) { return invFail(res, e); }
        }

        if (action === 'inventory_waste' && req.method === 'POST') {
            const actor = await invActor();
            if (!canOps(actor)) return res.status(403).json({ error: "Unauthorized" });
            try {
                const result = await inventoryEngine.wasteStock(supabase, { ...(req.body || {}), restaurantId: currentResId, actor });
                return res.json({ success: true, ...result });
            } catch (e) { return invFail(res, e); }
        }

        if (action === 'inventory_count' && req.method === 'POST') {
            const actor = await invActor();
            if (!canOps(actor)) return res.status(403).json({ error: "Unauthorized" });
            try {
                const result = await inventoryEngine.countWalk(supabase, { ...(req.body || {}), restaurantId: currentResId, actor });
                return res.json({ success: true, ...result });
            } catch (e) { return invFail(res, e); }
        }

        if (action === 'inventory_flag' && req.method === 'POST') {
            const actor = await invActor();
            if (!canOps(actor)) return res.status(403).json({ error: "Unauthorized" });
            try {
                const b = req.body || {};
                const result = await inventoryEngine.setPrepFlag(supabase, {
                    restaurantId: currentResId, actor,
                    prepSlug: b.prep_slug, flag: b.flag, note: b.note
                });
                return res.json({ success: true, ...result });
            } catch (e) { return invFail(res, e); }
        }

        if (action === 'inventory_flag_clear' && req.method === 'POST') {
            const actor = await invActor();
            if (!canOps(actor)) return res.status(403).json({ error: "Unauthorized" });
            try {
                const result = await inventoryEngine.clearPrepFlag(supabase, {
                    actor, flagId: (req.body || {}).flag_id
                });
                return res.json({ success: true, ...result });
            } catch (e) { return invFail(res, e); }
        }

        if (action === 'inventory_tidy' && req.method === 'POST') {
            const actor = await invActor();
            if (!actor) return res.status(401).json({ error: "No autorizado" });
            try {
                const event = await inventoryEngine.logEvent(supabase, {
                    restaurantId: currentResId, kind: 'tidy', actor,
                    note: (req.body || {}).note || 'Tidy Check: frente, terraza y baños'
                });
                return res.json({ success: true, event });
            } catch (e) { return invFail(res, e); }
        }

        if (action === 'inventory_alert' && req.method === 'POST') {
            // §7i + ROLES: reportar un faltante es el único derecho de
            // inventario del Cajero — cualquier personal activo avisa.
            const actor = await invActor();
            if (!actor) return res.status(401).json({ error: "No autorizado" });
            try {
                const b = req.body || {};
                const result = await inventoryEngine.staffAlert(supabase, {
                    restaurantId: currentResId, actor,
                    alertKind: b.alert_kind, note: b.note,
                    inventoryItemId: b.inventory_item_id, itemName: b.item_name
                });
                return res.json({ success: true, delivered: result.delivered });
            } catch (e) { return invFail(res, e); }
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

        // --- LOYALTY: REGALOS (two-bucket config + deals engine, 2026-10-30) ---
        // Everything the Regalos tab needs: the settings that govern
        // Rico Cash (restaurants.settings.loyalty), the campaign CRUD
        // for deals types 1–3, and the numbers the COST PANEL runs on
        // (per-item food cost — the same computation as the margin chip
        // — plus recent sales and the month's granted face so far).
        if (action === 'loyalty_data' && req.method === 'GET') {
            if (!isAdmin) return res.status(403).json({ error: "Unauthorized" });
            const resId = req.query.restaurantId || 'rich-aroma';
            try {
                const settings = await ricoLoyalty.getLoyaltySettings(supabase, resId);
                const [rItems, rLines, rInv, rCustCount, rSales, rGrants] = await Promise.all([
                    supabase.from('menu_items').select('id, name, price, category, is_house_made').eq('restaurant_id', resId).order('name'),
                    supabase.from('menu_item_ingredients').select('menu_item_id, inventory_item_id, quantity'),
                    supabase.from('inventory').select('id, cost_per_unit'),
                    supabase.from('customers').select('id'),
                    supabase.from('orders').select('total, created_at').gte('created_at', new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()),
                    supabase.from('balance_history').select('amount, source, created_at').eq('type', 'bonus_grant').gte('created_at', new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString())
                ]);
                const costOf = {};
                (rInv.data || []).forEach(r => { costOf[r.id] = (r.cost_per_unit === null || r.cost_per_unit === undefined) ? null : parseFloat(r.cost_per_unit); });
                const byItem = {};
                (rLines.data || []).forEach(l => { (byItem[l.menu_item_id] = byItem[l.menu_item_id] || []).push(l); });
                const items = (rItems.data || []).map(it => {
                    let sum = 0, priced = 0;
                    (byItem[it.id] || []).forEach(l => {
                        const c = costOf[l.inventory_item_id];
                        if (c !== null && c !== undefined) { sum += parseFloat(l.quantity || 0) * c; priced++; }
                    });
                    return { ...it, food_cost: priced > 0 ? Math.round(sum * 100) / 100 : null };
                });
                const sales7d = (rSales.data || []).reduce((s, o) => s + (parseFloat(o.total) || 0), 0);
                const orders7d = (rSales.data || []).length;
                const monthGranted = (rGrants.data || [])
                    .filter(g => ['campaign', 'manual', 'mission'].includes(g.source))
                    .reduce((s, g) => s + (parseFloat(g.amount) || 0), 0);
                return res.json({
                    success: true, settings, items,
                    customers_count: (rCustCount.data || []).length,
                    sales_last_7d: Math.round(sales7d * 100) / 100,
                    orders_last_7d: orders7d,
                    avg_ticket_7d: orders7d > 0 ? Math.round((sales7d / orders7d) * 100) / 100 : 0,
                    month_granted_face: Math.round(monthGranted * 100) / 100
                });
            } catch (e) {
                return res.status(500).json({ error: e.message });
            }
        }

        if (action === 'loyalty_settings_save' && req.method === 'POST') {
            if (!isAdmin) return res.status(403).json({ error: "Unauthorized" });
            const resId = req.body?.restaurantId || 'rich-aroma';
            const incoming = (req.body && req.body.loyalty) || {};
            try {
                const clean = {};
                if (incoming.earn_rate !== undefined) clean.earn_rate = Math.min(1, Math.max(0, parseFloat(incoming.earn_rate) || 0));
                if (incoming.launch_week !== undefined) clean.launch_week = !!incoming.launch_week;
                if (incoming.launch_multiplier !== undefined) clean.launch_multiplier = Math.min(5, Math.max(1, parseFloat(incoming.launch_multiplier) || 1));
                if (incoming.gift_expiry_days !== undefined) clean.gift_expiry_days = Math.min(365, Math.max(1, parseInt(incoming.gift_expiry_days) || 60));
                if (incoming.manual_grant_cap !== undefined) clean.manual_grant_cap = Math.max(0, parseFloat(incoming.manual_grant_cap) || 0);
                if (incoming.monthly_promo_cap !== undefined) clean.monthly_promo_cap = Math.max(0, parseFloat(incoming.monthly_promo_cap) || 0);
                if (Array.isArray(incoming.ladder)) {
                    clean.ladder = incoming.ladder
                        .map(t => ({ min: parseFloat(t.min) || 0, bonus: parseFloat(t.bonus) || 0 }))
                        .filter(t => t.min > 0 && t.bonus > 0)
                        .sort((a, b) => a.min - b.min);
                }
                // Racha del Capitán (2026-10-30)
                if (incoming.streak_enabled !== undefined) clean.streak_enabled = !!incoming.streak_enabled;
                if (Array.isArray(incoming.streak_ladder)) {
                    clean.streak_ladder = incoming.streak_ladder
                        .map(v => Math.min(50, Math.max(0, parseFloat(v) || 0)))
                        .filter(v => v > 0).slice(0, 8);
                    if (!clean.streak_ladder.length) delete clean.streak_ladder;
                }
                // Difusión del Capitán (2026-10-30): ceiling is 2–4/month, structurally
                if (incoming.broadcast_monthly_cap !== undefined) clean.broadcast_monthly_cap = Math.min(4, Math.max(2, parseInt(incoming.broadcast_monthly_cap) || 4));
                if (incoming.broadcast_template_name !== undefined) clean.broadcast_template_name = String(incoming.broadcast_template_name || '').slice(0, 120);
                if (incoming.broadcast_template_approved !== undefined) clean.broadcast_template_approved = !!incoming.broadcast_template_approved;
                if (incoming.broadcast_template_cost !== undefined) clean.broadcast_template_cost = Math.max(0, parseFloat(incoming.broadcast_template_cost) || 0);
                // Especial del Día (2026-10-30)
                if (incoming.especial_push_time !== undefined && /^\d{1,2}:\d{2}$/.test(String(incoming.especial_push_time))) clean.especial_push_time = String(incoming.especial_push_time);
                if (incoming.especial_template_name !== undefined) clean.especial_template_name = String(incoming.especial_template_name || '').slice(0, 120);
                const { data: resRow } = await supabase.from('restaurants').select('settings').eq('id', resId).maybeSingle();
                const settings = (resRow && resRow.settings) || {};
                settings.loyalty = { ...(settings.loyalty || {}), ...clean };
                const { error } = await supabase.from('restaurants').update({ settings }).eq('id', resId);
                if (error) throw error;
                return res.json({ success: true, loyalty: settings.loyalty, message: 'Configuración de Rico Cash guardada' });
            } catch (e) {
                return res.status(500).json({ error: e.message });
            }
        }

        if (action === 'loyalty_campaigns' && req.method === 'GET') {
            if (!isAdmin) return res.status(403).json({ error: "Unauthorized" });
            const resId = req.query.restaurantId || 'rich-aroma';
            try {
                const { data: campaigns, error } = await supabase.from('loyalty_campaigns')
                    .select('*').eq('restaurant_id', resId).order('created_at', { ascending: false });
                if (error) throw error;
                const { data: grants } = await supabase.from('balance_history')
                    .select('campaign_id, amount').eq('type', 'bonus_grant').not('campaign_id', 'is', null);
                const stats = {};
                (grants || []).forEach(g => {
                    const s = stats[g.campaign_id] || (stats[g.campaign_id] = { grants_count: 0, granted_face: 0 });
                    s.grants_count++; s.granted_face = Math.round((s.granted_face + (parseFloat(g.amount) || 0)) * 100) / 100;
                });
                return res.json({ success: true, campaigns: (campaigns || []).map(c => ({ ...c, stats: stats[c.id] || { grants_count: 0, granted_face: 0 } })) });
            } catch (e) {
                return res.status(500).json({ error: e.message });
            }
        }

        if (action === 'loyalty_campaign_save' && req.method === 'POST') {
            if (!isAdmin) return res.status(403).json({ error: "Unauthorized" });
            const b = req.body || {};
            const TYPES = ['multiplicador', 'compra_x_lleva', 'regalo'];
            if (!TYPES.includes(b.type)) return res.status(400).json({ error: 'Tipo de oferta no válido' });
            if (!String(b.name || '').trim()) return res.status(400).json({ error: 'La oferta necesita un nombre' });
            try {
                const row = {
                    id: b.id || ('camp_' + Date.now() + Math.floor(Math.random() * 1000)),
                    restaurant_id: b.restaurantId || 'rich-aroma',
                    type: b.type,
                    name: String(b.name).trim().slice(0, 80),
                    config: (b.config && typeof b.config === 'object') ? b.config : {},
                    active: !!b.active,
                    starts_at: b.starts_at || null,
                    ends_at: b.ends_at || null,
                    over_cap_ack: !!b.over_cap_ack,
                    created_by: b.created_by || 'admin',
                    updated_at: new Date().toISOString()
                };
                const { data, error } = await supabase.from('loyalty_campaigns')
                    .upsert(row, { onConflict: 'id' }).select().single();
                if (error) throw error;
                return res.json({ success: true, campaign: data, message: `Oferta "${row.name}" guardada` });
            } catch (e) {
                return res.status(500).json({ error: e.message });
            }
        }

        if (action === 'loyalty_campaign_toggle' && req.method === 'POST') {
            if (!isAdmin) return res.status(403).json({ error: "Unauthorized" });
            const { id: campId, active, over_cap_ack } = req.body || {};
            if (!campId) return res.status(400).json({ error: 'id requerido' });
            try {
                const updates = { active: !!active, updated_at: new Date().toISOString() };
                if (over_cap_ack !== undefined) updates.over_cap_ack = !!over_cap_ack;
                const { data, error } = await supabase.from('loyalty_campaigns')
                    .update(updates).eq('id', campId).select().single();
                if (error) throw error;
                return res.json({ success: true, campaign: data });
            } catch (e) {
                return res.status(500).json({ error: e.message });
            }
        }

        // --- DIFUSIÓN DEL CAPITÁN (2026-10-30) ---
        // The cost panel is computed server-side (rico-loyalty) from the
        // live audience: customers inside an open 24h window receive a
        // free-form message (no Meta cost); everyone else opted-in is
        // reachable ONLY through the approved marketing template.
        async function broadcastContext(resId, campaignId) {
            let campaign = null, getItem = null;
            if (campaignId) {
                const { data: c } = await supabase.from('loyalty_campaigns')
                    .select('*').eq('id', campaignId).maybeSingle();
                campaign = c || null;
            }
            // Blended COGS from the costed menu (same math as loyalty_data).
            const [rItems, rLines, rInv, rSales] = await Promise.all([
                supabase.from('menu_items').select('id, price').eq('restaurant_id', resId),
                supabase.from('menu_item_ingredients').select('menu_item_id, inventory_item_id, quantity'),
                supabase.from('inventory').select('id, cost_per_unit'),
                supabase.from('orders').select('total, created_at').gte('created_at', new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString())
            ]);
            const costOf = {};
            (rInv.data || []).forEach(r => { costOf[r.id] = (r.cost_per_unit === null || r.cost_per_unit === undefined) ? null : parseFloat(r.cost_per_unit); });
            const byItem = {};
            (rLines.data || []).forEach(l => { (byItem[l.menu_item_id] = byItem[l.menu_item_id] || []).push(l); });
            let fcSum = 0, priceSum = 0;
            const itemCosts = {};
            (rItems.data || []).forEach(it => {
                let sum = 0, priced = 0;
                (byItem[it.id] || []).forEach(l => {
                    const cst = costOf[l.inventory_item_id];
                    if (cst !== null && cst !== undefined) { sum += parseFloat(l.quantity || 0) * cst; priced++; }
                });
                const fc = priced > 0 ? Math.round(sum * 100) / 100 : null;
                itemCosts[it.id] = { price: parseFloat(it.price) || 0, food_cost: fc };
                if (fc !== null) { fcSum += fc; priceSum += parseFloat(it.price) || 0; }
            });
            const blendedCogs = priceSum > 0 ? Math.min(0.9, Math.max(0.05, fcSum / priceSum)) : 0.30;
            const sales7d = (rSales.data || []).reduce((s, o) => s + (parseFloat(o.total) || 0), 0);
            const avgTicket = (rSales.data || []).length > 0 ? sales7d / (rSales.data || []).length : 0;
            if (campaign && campaign.type === 'compra_x_lleva' && (campaign.config || {}).get_item_id) {
                getItem = itemCosts[campaign.config.get_item_id] || null;
            }
            return { campaign, getItem, blendedCogs, avgTicket };
        }

        if (action === 'broadcast_preview' && req.method === 'POST') {
            if (!isAdmin) return res.status(403).json({ error: "Unauthorized" });
            const resId = req.body?.restaurantId || 'rich-aroma';
            try {
                const ctx = await broadcastContext(resId, req.body?.campaign_id || null);
                const preview = await ricoLoyalty.broadcastPreview(supabase, {
                    restaurantId: resId, campaign: ctx.campaign, getItem: ctx.getItem,
                    blendedCogs: ctx.blendedCogs, avgTicket: ctx.avgTicket,
                    expectedUses: req.body?.expected_uses != null ? parseInt(req.body.expected_uses) : null
                });
                return res.json({ success: true, preview });
            } catch (e) {
                return res.status(500).json({ error: e.message });
            }
        }

        if (action === 'broadcast_send' && req.method === 'POST') {
            if (!isAdmin) return res.status(403).json({ error: "Unauthorized" });
            const resId = req.body?.restaurantId || 'rich-aroma';
            const message = String(req.body?.message || '').trim();
            if (!message) return res.status(400).json({ error: 'Escribí el mensaje de la difusión.' });
            try {
                const settings = await ricoLoyalty.getLoyaltySettings(supabase, resId);
                const used = await ricoLoyalty.broadcastsThisMonth(supabase, resId);
                const cap = parseInt(settings.broadcast_monthly_cap) || 4;
                if (used >= cap) {
                    return res.status(400).json({ error: `Ya usaste las ${cap} difusiones de este mes. El límite se renueva el mes que viene.` });
                }
                const ctx = await broadcastContext(resId, req.body?.campaign_id || null);
                const preview = await ricoLoyalty.broadcastPreview(supabase, {
                    restaurantId: resId, campaign: ctx.campaign, getItem: ctx.getItem,
                    blendedCogs: ctx.blendedCogs, avgTicket: ctx.avgTicket,
                    expectedUses: req.body?.expected_uses != null ? parseInt(req.body.expected_uses) : null
                });
                const scope = req.body?.scope === 'window' ? 'window' : 'all';
                if (scope === 'all' && preview.template_state === 'pending') {
                    return res.status(400).json({ error: 'Tu plantilla de marketing todavía no está aprobada por Meta, así que por ahora la difusión solo puede salir para los clientes que te escribieron en las últimas 24 horas. Elegí "Solo ventana de 24h" o esperá la aprobación.' });
                }
                const aud = await ricoLoyalty.broadcastAudience(supabase);
                const windowPhones = aud.window.map(c => c.phone);
                const templatePhones = scope === 'all' ? aud.template.map(c => c.phone) : [];
                const row = {
                    id: 'bcast_' + Date.now(),
                    restaurant_id: resId,
                    message,
                    template_name: settings.broadcast_template_name || null,
                    campaign_id: req.body?.campaign_id || null,
                    window_count: aud.window.length,
                    template_count: aud.template.length,
                    est_cost: preview.total_cost,
                    status: 'sending',
                    created_by: 'admin'
                };
                const { error: insErr } = await supabase.from('broadcasts').insert(row);
                if (insErr) throw insErr;
                const result = await ricoLoyalty.sendViaBotBroadcast({
                    windowPhones, templatePhones, message,
                    templateName: settings.broadcast_template_name || ''
                });
                if (!result) {
                    await supabase.from('broadcasts').update({ status: 'failed' }).eq('id', row.id);
                    return res.status(502).json({ error: 'El bot de WhatsApp no respondió. La difusión quedó registrada como fallida y NO cuenta contra tu límite si la reintentás desde una conexión sana — revisá que el bot esté despierto y probá de nuevo.' });
                }
                await supabase.from('broadcasts').update({
                    status: 'sent',
                    sent_window: result.sent_window || 0,
                    sent_template: result.sent_template || 0
                }).eq('id', row.id);
                return res.json({
                    success: true,
                    sent_window: result.sent_window || 0,
                    sent_template: result.sent_template || 0,
                    failed: result.failed || 0,
                    month_used: used + 1,
                    month_cap: cap,
                    message: `Difusión enviada: ${result.sent_window || 0} mensajes libres (ventana de 24h) y ${result.sent_template || 0} por plantilla. Te quedan ${cap - used - 1} este mes.`
                });
            } catch (e) {
                return res.status(500).json({ error: e.message });
            }
        }

        // --- ESPECIAL DEL DÍA (2026-10-30) ---
        if (action === 'especial_data' && req.method === 'GET') {
            if (!isAdmin) return res.status(403).json({ error: "Unauthorized" });
            const resId = req.query.restaurantId || 'rich-aroma';
            try {
                const settings = await ricoLoyalty.getLoyaltySettings(supabase, resId);
                const today = ricoLoyalty.tguDateKey(new Date());
                const tomorrow = ricoLoyalty.tguDateKey(new Date(Date.now() + 24 * 3600 * 1000));
                const { data: specials } = await supabase.from('daily_specials')
                    .select('*').eq('restaurant_id', resId).in('special_date', [today, tomorrow]);
                const out = [];
                for (const s of (specials || [])) {
                    const { data: claims } = await supabase.from('special_claims')
                        .select('id, redeemed_at').eq('special_id', s.id);
                    out.push({
                        ...s,
                        claims_count: (claims || []).length,
                        redeemed_count: (claims || []).filter(r => r.redeemed_at).length
                    });
                }
                return res.json({ success: true, settings, today, tomorrow, specials: out });
            } catch (e) {
                return res.status(500).json({ error: e.message });
            }
        }

        if (action === 'especial_save' && req.method === 'POST') {
            if (!isAdmin) return res.status(403).json({ error: "Unauthorized" });
            const resId = req.body?.restaurantId || 'rich-aroma';
            try {
                const dateKey = req.body?.date
                    || (parseInt(req.body?.date_offset) === 1
                        ? ricoLoyalty.tguDateKey(new Date(Date.now() + 24 * 3600 * 1000))
                        : ricoLoyalty.tguDateKey(new Date()));
                const kind = req.body?.kind === 'deal' ? 'deal' : 'item';
                const row = {
                    restaurant_id: resId,
                    special_date: dateKey,
                    item_id: kind === 'item' ? (req.body?.item_id || null) : null,
                    campaign_id: kind === 'deal' ? (req.body?.campaign_id || null) : null,
                    cap: Math.max(1, parseInt(req.body?.cap) || 20),
                    starts_time: /^\d{1,2}:\d{2}$/.test(String(req.body?.starts_time || '')) ? String(req.body.starts_time) : '08:00',
                    ends_time: /^\d{1,2}:\d{2}$/.test(String(req.body?.ends_time || '')) ? String(req.body.ends_time) : '18:00',
                    active: req.body?.active !== false,
                    // The caption NEVER reveals the deal — it drives people
                    // to text ESPECIAL. The owner posts it himself.
                    ig_caption: '🤫 Hoy hay un secreto en Rich Aroma… ☕\nTenemos un ESPECIAL DEL DÍA que solo se revela por WhatsApp.\nEscribinos "ESPECIAL" al +504 9905-4412 y te lo contamos 🎁\n📍 Quimistán, Santa Bárbara — Rich Aroma Coffee Shop'
                };
                if (kind === 'item' && !row.item_id) return res.status(400).json({ error: 'Elegí el artículo del especial.' });
                if (kind === 'deal' && !row.campaign_id) return res.status(400).json({ error: 'Elegí la oferta del especial.' });
                const { data: existing } = await supabase.from('daily_specials')
                    .select('id').eq('restaurant_id', resId).eq('special_date', dateKey).maybeSingle();
                let saved;
                if (existing) {
                    const { data, error } = await supabase.from('daily_specials')
                        .update(row).eq('id', existing.id).select().single();
                    if (error) throw error;
                    saved = data;
                } else {
                    const { data, error } = await supabase.from('daily_specials')
                        .insert({ id: 'especial_' + dateKey.replace(/-/g, ''), created_by: 'admin', ...row })
                        .select().single();
                    if (error) throw error;
                    saved = data;
                }
                // Cost panel verdict: max exposure = cap × margin cost.
                const ctx = await broadcastContext(resId, null);
                const per = await ricoLoyalty.especialPerUseCost(supabase, saved, {
                    blendedCogs: ctx.blendedCogs, avgTicket: ctx.avgTicket
                });
                return res.json({
                    success: true, special: saved,
                    per_use_cost: per.perUse, cost_basis: per.basis,
                    max_exposure: Math.round(per.perUse * row.cap * 100) / 100,
                    message: `Especial guardado para el ${dateKey}. Si nadie lo reclama, no cuesta nada.`
                });
            } catch (e) {
                return res.status(500).json({ error: e.message });
            }
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
