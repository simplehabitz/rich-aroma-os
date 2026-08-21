const { supabase } = require('./lib/supabase');
let stripe;
try {
    stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
} catch (e) {
    console.warn("Stripe initialization failed (likely missing key)");
}

module.exports = async (req, res) => {
    try {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (req.method === 'OPTIONS') return res.status(200).end();

        const { action, id } = req.query;

        // 1. GET PRODUCTS
        if (req.method === 'GET' && action === 'products') {
            const { data, error } = await supabase.from('cali_products').select('*').order('created_at', { ascending: false });
            if (error) throw error;
            return res.json(data || []);
        }

        // 2. GET LOCATIONS
        if (req.method === 'GET' && action === 'locations') {
            const { data: locations, error: locErr } = await supabase
                .from('cali_locations')
                .select('*')
                .eq('active', true)
                .order('name');
            
            if (locErr) throw locErr;

            // Get last Monday at 00:00:00 local time (ordering cycle start)
            const now = new Date();
            const day = now.getDay();
            const diff = now.getDate() - day + (day === 0 ? -6 : 1);
            const lastMonday = new Date(now.setDate(diff));
            lastMonday.setHours(0, 0, 0, 0);

            // Fetch paid/confirmed orders in the current cycle
            const { data: orders, error: ordersErr } = await supabase
                .from('cali_orders')
                .select('location_id, selections')
                .in('status', ['paid', 'confirmed'])
                .gte('created_at', lastMonday.toISOString());

            let currentBottlesMap = {};
            if (!ordersErr && orders) {
                for (const order of orders) {
                    let bottlesCount = 0;
                    const cart = order.selections?.cart || [];
                    for (const item of cart) {
                        if (typeof item.bottles === 'number') {
                            bottlesCount += item.bottles;
                        } else {
                            const qty = parseInt(item.qty || 1);
                            const selectionsCount = Array.isArray(item.selections) ? item.selections.length : 1;
                            bottlesCount += selectionsCount * qty;
                        }
                    }
                    const locId = order.location_id;
                    if (locId) {
                        currentBottlesMap[locId] = (currentBottlesMap[locId] || 0) + bottlesCount;
                    }
                }
            }

            const locationsWithCounts = (locations || []).map(loc => ({
                ...loc,
                current_bottles: currentBottlesMap[loc.id] || 0
            }));

            return res.json(locationsWithCounts);
        }

        // 2b. GET ACTIVE GROUP DROPS & TEAM POOLS
        if (req.method === 'GET' && action === 'active_drops') {
            try {
                // Fetch recent orders in the last 7 days to calculate live group pools
                const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
                const { data: recentOrders, error } = await supabase
                    .from('cali_orders')
                    .select('id, location_id, destination_name, customer_name, total_amount, selections, created_at, status')
                    .gte('created_at', sevenDaysAgo)
                    .neq('status', 'cancelled');

                const dropMap = {};

                if (!error && recentOrders && recentOrders.length > 0) {
                    recentOrders.forEach(o => {
                        const sel = o.selections || {};
                        const dest = (o.destination_name || sel.drop_location || (o.location_id === 'kaiser-bp' ? 'Kaiser Permanente Baldwin Park' : o.location_id) || '').trim();
                        if (!dest) return;

                        if (!dropMap[dest]) {
                            const slug = dest.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 35);
                            let icon = "🏢";
                            if (dest.toLowerCase().includes('kaiser') || dest.toLowerCase().includes('hospital') || dest.toLowerCase().includes('medical')) icon = "🏥";
                            else if (dest.toLowerCase().includes('school') || dest.toLowerCase().includes('high') || dest.toLowerCase().includes('college')) icon = "🏫";
                            
                            dropMap[dest] = {
                                name: dest,
                                slug: slug,
                                icon: icon,
                                city: sel.drop_address || "SoCal",
                                total_bottles: 0,
                                orders_count: 0,
                                participants: []
                            };
                        }

                        const cart = sel.cart || [];
                        let bCount = cart.reduce((sum, i) => sum + (typeof i.bottles === 'number' ? i.bottles : (parseInt(i.qty) || 1)), 0);
                        dropMap[dest].total_bottles += bCount;
                        dropMap[dest].orders_count += 1;
                        if (o.customer_name && !dropMap[dest].participants.includes(o.customer_name)) {
                            dropMap[dest].participants.push(o.customer_name);
                        }
                    });
                }

                const dropsList = Object.values(dropMap).map(d => ({
                    ...d,
                    is_free_delivery: d.total_bottles >= 20,
                    bottles_needed: Math.max(0, 20 - d.total_bottles),
                    progress_pct: Math.min(100, Math.round((d.total_bottles / 20) * 100))
                }));

                return res.json(dropsList);
            } catch (err) {
                console.error("active_drops error:", err);
                return res.json([]);
            }
        }

        // 3. VALIDATE PROMO CODE
        if (req.method === 'GET' && action === 'validate_promo') {
            const { code } = req.query;
            if (!code) return res.status(400).json({ error: 'Code required' });
            
            const { data: seller, error } = await supabase
                .from('customers')
                .select('id, name, referral_code')
                .eq('referral_code', code.toUpperCase())
                .contains('tags', ['cali_seller'])
                .single();
            
            if (error || !seller) return res.status(404).json({ error: 'Invalid or inactive promo code' });
            return res.json({ success: true, seller_name: seller.name, discount_percent: 5 });
        }

        // 3c. REQUEST WORKPLACE / HOSPITAL FRIDGE HUB LEAD
        if (req.method === 'POST' && action === 'request_workplace_hub') {
            const { company_name, address, city, department, contact_name, contact_phone, contact_email, est_headcount, notes } = req.body || {};
            
            if (!company_name || !contact_name) {
                return res.status(400).json({ error: 'Company Name and Contact Name are required.' });
            }

            try {
                const { sendEmail } = require('./lib/email-service');
                await sendEmail({
                    to: ['orders@richaromacoffee.com'],
                    subject: `🏢 New Workplace Fridge Hub Request: ${company_name} (${city || 'SoCal'})`,
                    html: `
                        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0d5c1; border-radius: 16px; background-color: #fdfbf7;">
                            <h2 style="color: #4a2c11; margin-top: 0;">🏢 New Workplace Fridge Drop Request!</h2>
                            <p style="color: #666; font-size: 14px;">An employee or team lead has requested a recurring Rich Aroma coffee fridge drop at their facility:</p>
                            
                            <div style="background: white; padding: 15px; border-radius: 12px; border: 1px solid #eae2d5; margin: 15px 0;">
                                <p style="margin: 6px 0;"><strong>Company / Hospital:</strong> ${company_name}</p>
                                <p style="margin: 6px 0;"><strong>Address:</strong> ${address || 'N/A'}, ${city || ''}</p>
                                <p style="margin: 6px 0;"><strong>Department / Breakroom:</strong> ${department || 'General Breakroom'}</p>
                                <p style="margin: 6px 0;"><strong>Estimated Team Size:</strong> ${est_headcount || 'Not specified'}</p>
                                <hr style="border: 0; border-top: 1px solid #eee; margin: 10px 0;">
                                <p style="margin: 6px 0;"><strong>Contact Person:</strong> ${contact_name}</p>
                                <p style="margin: 6px 0;"><strong>Phone:</strong> ${contact_phone || 'N/A'}</p>
                                <p style="margin: 6px 0;"><strong>Email:</strong> ${contact_email || 'N/A'}</p>
                                ${notes ? `<p style="margin: 6px 0;"><strong>Notes:</strong> ${notes}</p>` : ''}
                            </div>
                            <p style="font-size: 12px; color: #888;">Follow up to drop off their complimentary sample 5-pack and set up the breakroom hub!</p>
                        </div>
                    `
                });
            } catch (e) {
                console.error("Error sending hub request email:", e);
            }

            return res.json({ success: true, message: "Workplace hub request received! We'll reach out to coordinate your free sample 5-pack." });
        }
 
        // 3b. GET DIGITAL STAMPS & SHIFT STREAKS
        if (req.method === 'GET' && action === 'get_stamps') {
            const { phone } = req.query;
            if (!phone) return res.status(400).json({ error: 'Phone parameter is required' });
            
            // Clean up phone string to match format if needed
            const cleanPhone = phone.replace(/\D/g, '');
            
            const { data: pastOrders, error } = await supabase
                .from('cali_orders')
                .select('selections, created_at')
                .eq('customer_phone', phone)
                .in('status', ['paid', 'confirmed', 'delivered'])
                .order('created_at', { ascending: false });
                
            if (error && error.code !== '42703') throw error;
            
            let totalBottles = 0;
            let totalFreeRedeemed = 0;
            
            if (pastOrders) {
                for (const order of pastOrders) {
                    const cart = order.selections?.cart || [];
                    const freeInOrder = parseInt(order.selections?.free_bottles_redeemed || 0);
                    totalFreeRedeemed += freeInOrder;
                    
                    for (const item of cart) {
                        if (item.product_id === 'catering_event_pack') continue;
                        if (typeof item.bottles === 'number') {
                            totalBottles += item.bottles;
                        } else {
                            const qty = parseInt(item.qty || 1);
                            const selectionsCount = Array.isArray(item.selections) ? item.selections.length : 1;
                            totalBottles += selectionsCount * qty;
                        }
                    }
                }
            }
            
            const paidBottles = totalBottles - totalFreeRedeemed;
            const currentStamps = paidBottles % 9;
            const earnedFree = Math.floor(paidBottles / 9) - totalFreeRedeemed;
            
            // Calculate consecutive weekly order streak
            let streakWeeks = 0;
            if (pastOrders && pastOrders.length > 0) {
                const orderDates = pastOrders.map(o => new Date(o.created_at || Date.now()));
                const getWeekKey = (d) => {
                    const date = new Date(d.getTime());
                    date.setHours(0, 0, 0, 0);
                    date.setDate(date.getDate() + 3 - (date.getDay() + 6) % 7);
                    const week1 = new Date(date.getFullYear(), 0, 4);
                    const wNum = 1 + Math.round(((date.getTime() - week1.getTime()) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
                    return `${date.getFullYear()}-W${wNum}`;
                };
                const weeks = [...new Set(orderDates.map(d => getWeekKey(d)))];
                streakWeeks = weeks.length;
            }
            
            return res.json({
                total_bottles: totalBottles,
                total_free_redeemed: totalFreeRedeemed,
                paid_bottles: paidBottles >= 0 ? paidBottles : 0,
                stamps: currentStamps >= 0 ? currentStamps : 0,
                earned_free: earnedFree >= 0 ? earnedFree : 0,
                streak_weeks: streakWeeks
            });
        }

        // 3c. GET CALI COFFEE CARD BALANCE (30-Day FIFO Expiration)
        if (req.method === 'GET' && action === 'get_credits') {
            const { phone } = req.query;
            if (!phone) return res.status(400).json({ error: 'Phone parameter is required' });

            try {
                const now = new Date().toISOString();
                // Get unexpired loads + bonus
                const { data: loads, error: loadErr } = await supabase
                    .from('cali_credit_transactions')
                    .select('amount')
                    .eq('phone', phone)
                    .in('type', ['load', 'bonus'])
                    .gt('expires_at', now);

                if (loadErr && loadErr.code === '42P01') {
                    // Table not created yet
                    return res.json({ phone, balance: 0.00, has_pin: false });
                }

                // Get all spends
                const { data: spends } = await supabase
                    .from('cali_credit_transactions')
                    .select('amount')
                    .eq('phone', phone)
                    .eq('type', 'spend');

                const totalLoaded = (loads || []).reduce((sum, row) => sum + parseFloat(row.amount || 0), 0);
                const totalSpent = (spends || []).reduce((sum, row) => sum + parseFloat(row.amount || 0), 0);
                const activeBalance = Math.max(0, totalLoaded - totalSpent);

                // Check if user has PIN configured
                const { data: userProfile } = await supabase
                    .from('cali_credits')
                    .select('pin_hash')
                    .eq('phone', phone)
                    .maybeSingle();

                return res.json({
                    phone,
                    balance: parseFloat(activeBalance.toFixed(2)),
                    has_pin: !!(userProfile && userProfile.pin_hash)
                });
            } catch (err) {
                console.warn("[Cali Credits] Table query fallback:", err.message);
                return res.json({ phone, balance: 0.00, has_pin: false });
            }
        }

        // 3d. SET OR UPDATE CALI COFFEE CARD PASSCODE
        if (req.method === 'POST' && action === 'set_pin') {
            const { phone, pin } = req.body || {};
            if (!phone || !pin || pin.toString().length !== 4) {
                return res.status(400).json({ error: 'Phone and 4-digit PIN are required' });
            }

            try {
                const { error } = await supabase
                    .from('cali_credits')
                    .upsert({ 
                        phone, 
                        pin_hash: pin.toString().trim(), 
                        updated_at: new Date().toISOString() 
                    }, { onConflict: 'phone' });

                if (error) throw error;
                return res.json({ success: true, message: 'PIN saved successfully' });
            } catch (err) {
                console.error("[Cali Credits] Save PIN error:", err);
                return res.status(500).json({ error: err.message });
            }
        }

        // 3e. LOAD PREPAID CREDITS (30-Day Expiration)
        if (req.method === 'POST' && action === 'load_credits') {
            const { phone, amount, pin, description, orderId } = req.body || {};
            const loadAmount = parseFloat(amount);
            if (!phone || isNaN(loadAmount) || loadAmount <= 0) {
                return res.status(400).json({ error: 'Invalid load parameters' });
            }

            try {
                // If pin is provided, save or update pin
                if (pin && pin.toString().length === 4) {
                    await supabase
                        .from('cali_credits')
                        .upsert({ 
                            phone, 
                            pin_hash: pin.toString().trim(), 
                            updated_at: new Date().toISOString() 
                        }, { onConflict: 'phone' });
                }

                // Calculate 30-day expiration date
                const expiresAt = new Date();
                expiresAt.setDate(expiresAt.getDate() + 30);

                const { data: tx, error } = await supabase
                    .from('cali_credit_transactions')
                    .insert({
                        phone,
                        amount: loadAmount,
                        type: 'load',
                        description: description || 'Prepaid Balance Load ($30-Day Expiry)',
                        order_id: orderId || null,
                        expires_at: expiresAt.toISOString()
                    })
                    .select()
                    .single();

                if (error) throw error;
                return res.json({ success: true, transaction: tx, expires_at: expiresAt.toISOString() });
            } catch (err) {
                console.error("[Cali Credits] Load error:", err);
                return res.status(500).json({ error: err.message });
            }
        }

        // 3f. GET PRIVATE COFFEE PASS DETAILS (Requires PIN Verification)
        if (req.method === 'POST' && action === 'get_pass_details') {
            const { phone, pin } = req.body || {};
            if (!phone || !pin) return res.status(400).json({ error: 'Phone and PIN are required' });

            // 1. Verify PIN
            const { data: userProfile } = await supabase
                .from('cali_credits')
                .select('pin_hash')
                .eq('phone', phone)
                .maybeSingle();

            if (!userProfile || !userProfile.pin_hash || userProfile.pin_hash !== pin.toString().trim()) {
                return res.status(401).json({ error: 'Invalid PIN. Please check or reset your 4-digit passcode.' });
            }

            // 2. Query Balance & Expiry
            const now = new Date().toISOString();
            const { data: loads } = await supabase
                .from('cali_credit_transactions')
                .select('amount, expires_at, created_at')
                .eq('phone', phone)
                .in('type', ['load', 'bonus'])
                .gt('expires_at', now)
                .order('expires_at', { ascending: true });

            const { data: spends } = await supabase
                .from('cali_credit_transactions')
                .select('amount')
                .eq('phone', phone)
                .eq('type', 'spend');

            const totalLoaded = (loads || []).reduce((sum, row) => sum + parseFloat(row.amount || 0), 0);
            const totalSpent = (spends || []).reduce((sum, row) => sum + parseFloat(row.amount || 0), 0);
            const activeBalance = Math.max(0, totalLoaded - totalSpent);

            let daysRemaining = 30;
            if (loads && loads.length > 0) {
                const earliestExpiry = new Date(loads[0].expires_at);
                const diffTime = earliestExpiry.getTime() - new Date().getTime();
                daysRemaining = Math.max(1, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
            }

            // 3. Query Past Orders for History & Streaks
            const { data: pastOrders } = await supabase
                .from('cali_orders')
                .select('id, total, status, created_at, selections, notes')
                .eq('customer_phone', phone)
                .order('created_at', { ascending: false })
                .limit(10);

            // Calculate Bottles & Stamps
            let totalBottles = 0;
            let totalFreeRedeemed = 0;
            if (pastOrders) {
                for (const order of pastOrders) {
                    const cart = order.selections?.cart || [];
                    const freeInOrder = parseInt(order.selections?.free_bottles_redeemed || 0);
                    totalFreeRedeemed += freeInOrder;
                    for (const item of cart) {
                        if (item.product_id === 'catering_event_pack') continue;
                        if (typeof item.bottles === 'number') totalBottles += item.bottles;
                        else {
                            const qty = parseInt(item.qty || 1);
                            const selectionsCount = Array.isArray(item.selections) ? item.selections.length : 1;
                            totalBottles += selectionsCount * qty;
                        }
                    }
                }
            }
            const paidBottles = Math.max(0, totalBottles - totalFreeRedeemed);
            const currentStamps = paidBottles % 9;

            // Calculate Weekly Streak
            let streakWeeks = 0;
            if (pastOrders && pastOrders.length > 0) {
                const getWeekKey = (d) => {
                    const date = new Date(d.getTime());
                    date.setHours(0, 0, 0, 0);
                    date.setDate(date.getDate() + 3 - (date.getDay() + 6) % 7);
                    const week1 = new Date(date.getFullYear(), 0, 4);
                    const wNum = 1 + Math.round(((date.getTime() - week1.getTime()) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
                    return `${date.getFullYear()}-W${wNum}`;
                };
                const weeks = [...new Set(pastOrders.map(o => getWeekKey(new Date(o.created_at || Date.now()))))];
                streakWeeks = weeks.length;
            }

            return res.json({
                success: true,
                balance: parseFloat(activeBalance.toFixed(2)),
                days_remaining: daysRemaining,
                stamps: currentStamps,
                streak_weeks: streakWeeks,
                orders: (pastOrders || []).map(o => ({
                    id: o.id,
                    date: o.created_at,
                    total: o.total,
                    status: o.status,
                    fulfillment: o.selections?.fulfillment_type || 'pickup',
                    hospital: o.selections?.kaiser_hospital || null,
                    dept: o.selections?.kaiser_department || null,
                    items_count: (o.selections?.cart || []).reduce((s, i) => s + (parseInt(i.qty) || 1), 0)
                }))
            });
        }

        // 4. ADMIN CHECK
        const auth = req.headers.authorization;
        const isAdmin = auth && (auth.includes('EMP-admin') || auth.includes('TEST_TOKEN_ADMIN') || auth.includes('Bearer 3620'));

        // 5. SELLERS MANAGEMENT
        if (action === 'sellers' && req.method === 'GET') {
            if (!isAdmin) return res.status(401).json({ error: 'Unauthorized' });
            const { data, error } = await supabase
                .from('customers')
                .select('id, name, phone, referral_code, tags')
                .contains('tags', ['cali_seller'])
                .order('name');
            if (error) throw error;
            return res.json(data || []);
        }

        if (action === 'add_seller' && req.method === 'POST') {
            if (!isAdmin) return res.status(401).json({ error: 'Unauthorized' });
            const { name, phone, code } = req.body;
            
            // 1. Check if customer exists (use maybeSingle to avoid errors if not found)
            const { data: existing, error: findError } = await supabase
                .from('customers')
                .select('*')
                .eq('phone', phone)
                .maybeSingle();
            
            if (findError) throw findError;
            
            if (existing) {
                // Update existing customer
                let newTags = Array.isArray(existing.tags) ? existing.tags : [];
                if (!newTags.includes('cali_seller')) newTags.push('cali_seller');
                
                const { data, error } = await supabase
                    .from('customers')
                    .update({ 
                        referral_code: code.toUpperCase(), 
                        tags: newTags 
                    })
                    .eq('id', existing.id)
                    .select().single();
                
                if (error) throw error;
                return res.json(data);
            } else {
                // Create new customer as seller
                // Generate a safer ID
                const { data: maxCust } = await supabase.from('customers').select('id').order('created_at', { ascending: false }).limit(1);
                const nextId = 'C' + (Math.floor(Math.random() * 900) + 100);

                const { data, error } = await supabase
                    .from('customers')
                    .insert({ 
                        id: nextId,
                        name, 
                        phone, 
                        referral_code: code.toUpperCase(), 
                        tags: ['cali_seller']
                    })
                    .select().single();
                
                if (error) throw error;
                return res.json(data);
            }
        }

        // 6. SUBSCRIPTIONS (Admin)
        if (action === 'subscriptions' && req.method === 'GET') {
            if (!isAdmin) return res.status(401).json({ error: 'Unauthorized' });
            const { data, error } = await supabase
                .from('cali_subscriptions')
                .select('*, cali_locations(name, city)')
                .order('created_at', { ascending: false });
            if (error) throw error;
            return res.json(data || []);
        }

        // 7. PRODUCT MANAGEMENT (ADD / EDIT / DELETE)
        if (action === 'products' && (req.method === 'POST' || (req.method === 'PUT' && id) || (req.method === 'DELETE' && id))) {
            if (!isAdmin) return res.status(401).json({ error: 'Unauthorized' });

            if (req.method === 'DELETE') {
                const { error: delErr } = await supabase.from('cali_products').delete().eq('id', id);
                if (delErr) {
                    console.error("Product delete error:", delErr);
                    return res.status(500).json({ error: delErr.message });
                }
                return res.json({ success: true, deleted: id });
            }

            const { imageBase64, image_url, name, price, active, description, ingredients, options, bottles_per_pack, inventory_limit } = req.body || {};
            
            let finalImageUrl = image_url || '';

            if (imageBase64 && imageBase64.startsWith('data:image')) {
                try {
                    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
                    const buffer = Buffer.from(base64Data, 'base64');
                    const mimeType = imageBase64.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg';
                    const ext = (mimeType.split('/')[1] || 'jpeg').replace('jpeg', 'jpg');
                    const storagePath = `cali_products/PROD_${id || Date.now()}_${Date.now()}.${ext}`;

                    const { error: uploadError } = await supabase.storage
                        .from('menu-images')
                        .upload(storagePath, buffer, { contentType: mimeType, upsert: true });

                    if (!uploadError) {
                        const { data: { publicUrl } } = supabase.storage.from('menu-images').getPublicUrl(storagePath);
                        finalImageUrl = publicUrl;
                    } else {
                        console.warn("Storage upload warn, falling back to base64 data URI:", uploadError.message);
                        finalImageUrl = imageBase64;
                    }
                } catch (err) {
                    console.error("Image upload exception, using fallback data URI:", err);
                    finalImageUrl = imageBase64;
                }
            }

            const sanitizedOptions = {
                ...(options || {}),
                description: description || options?.description || '',
                ingredients: ingredients || options?.ingredients || ''
            };

            const dbPayload = {
                name: name || 'Artisanal Drink',
                price: parseFloat(price || 0),
                active: active !== false,
                bottles_per_pack: bottles_per_pack || 1,
                options: sanitizedOptions
            };

            if (finalImageUrl) {
                dbPayload.image_url = finalImageUrl;
            }

            let result;
            if (req.method === 'POST') {
                result = await supabase.from('cali_products').insert(dbPayload).select();
            } else {
                result = await supabase.from('cali_products').update(dbPayload).eq('id', id).select();
            }

            if (result.error) {
                console.error("Product save error:", result.error);
                return res.status(500).json({ error: result.error.message });
            }
            return res.json(result.data?.[0] || { success: true, ...dbPayload, id });
        }

        // 5. LOCATION MANAGEMENT
        if (action === 'locations' && (req.method === 'POST' || (req.method === 'PUT' && id) || (req.method === 'DELETE' && id))) {
            if (!isAdmin) return res.status(401).json({ error: 'Unauthorized' });
            let result;
            
            // Ensure distributor_name is not null (DB requirement)
            const locationData = {
                ...req.body,
                distributor_name: req.body.distributor_name || ''
            };

            if (req.method === 'POST') {
                result = await supabase.from('cali_locations').insert(locationData).select().single();
            } else if (req.method === 'PUT') {
                result = await supabase.from('cali_locations').update(locationData).eq('id', id).select().single();
            } else if (req.method === 'DELETE') {
                result = await supabase.from('cali_locations').delete().eq('id', id);
            }
            if (result.error) throw result.error;
            return res.json(result.data || { success: true });
        }

        // 6. ORDERS (Admin)
        if (req.method === 'GET' && action === 'orders') {
            if (!isAdmin) return res.status(401).json({ error: 'Unauthorized' });
            const { data, error } = await supabase.from('cali_orders').select('*, cali_locations(name, city)').order('created_at', { ascending: false });
            if (error) throw error;
            return res.json(data || []);
        }

        // 6b. CREATE MANUAL ORDER
        if (req.method === 'POST' && action === 'create_manual_order') {
            if (!isAdmin) return res.status(401).json({ error: 'Unauthorized' });
            const { customer_name, customer_phone, location_id, total, status, selections, notes } = req.body;
            
            const { data, error } = await supabase.from('cali_orders').insert({
                customer_name,
                customer_phone,
                location_id,
                total,
                status: status || 'confirmed',
                selections: selections || {},
                notes: notes || '[MANUAL ORDER]'
            }).select().single();

            if (error) throw error;
            return res.json(data);
        }

        // 6d. CREATE SELF CHECKOUT ORDER (PUBLIC)
        if (req.method === 'POST' && action === 'create_self_checkout_order') {
            const { customer_name, customer_phone, location_id, total, selections, notes, receiptBase64 } = req.body;
            
            let receiptImageUrl = null;
            if (receiptBase64 && receiptBase64.startsWith('data:image')) {
                try {
                    const base64Data = receiptBase64.replace(/^data:image\/\w+;base64,/, "");
                    const buffer = Buffer.from(base64Data, 'base64');
                    const mimeType = receiptBase64.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/png';
                    const ext = mimeType.split('/')[1] || 'png';
                    const storagePath = `receipts/REC_${Date.now()}.${ext}`;

                    const { error: uploadError } = await supabase.storage
                        .from('menu-images')
                        .upload(storagePath, buffer, { contentType: mimeType, upsert: true });

                    if (!uploadError) {
                        const { data: { publicUrl } } = supabase.storage.from('menu-images').getPublicUrl(storagePath);
                        receiptImageUrl = publicUrl;
                    } else {
                        console.error("Receipt upload error:", uploadError);
                    }
                } catch (err) {
                    console.error("Receipt process failed:", err);
                }
            }
            
            const items = selections?.cart || [];
            const is_subscription = !!selections?.is_subscription;
            const promo_code = selections?.promo || null;

            // 1. Calculate discount percent
            let discountPercent = is_subscription ? 10 : 0;
            let sellerInfo = null;
            if (promo_code && !is_subscription) {
                const { data: seller } = await supabase
                    .from('customers')
                    .select('id, name, referral_code')
                    .eq('referral_code', promo_code.toUpperCase())
                    .contains('tags', ['cali_seller'])
                    .single();
                
                if (seller) {
                    discountPercent = 5;
                    sellerInfo = seller;
                }
            }

            // 2. Count bottles
            let calculatedTotalBottles = 0;
            for (const item of items) {
                if (item.product_id === 'catering_event_pack') continue;
                const count = (item.selections && Array.isArray(item.selections)) ? item.selections.length : 1;
                calculatedTotalBottles += (count * parseInt(item.qty || 1));
            }

            let volumeDiscount = 0;
            if (calculatedTotalBottles >= 5) {
                volumeDiscount = 1.50;
            } else if (calculatedTotalBottles >= 3) {
                volumeDiscount = 1.00;
            }

            // Fetch products to validate base prices and inventory stock
            const { data: productsData } = await supabase.from('cali_products').select('id, price, name, inventory_limit, options');
            const priceMap = {};
            if (productsData) {
                for (const p of productsData) {
                    priceMap[p.id] = parseFloat(p.price);
                }
            }

            // Helper to get milk counts for items
            function getMilkCounts(item) {
                const counts = { "Regular Milk": 0, "Oat Milk": 0 };
                const selections = (item.selections && Array.isArray(item.selections)) ? item.selections : [{}];
                const qty = parseInt(item.qty || 1);
                const multiplier = Math.max(1, qty / selections.length);
                for (const sel of selections) {
                    const milkSel = sel.milk || 'Regular';
                    const key = (milkSel === 'Oat Milk') ? 'Oat Milk' : 'Regular Milk';
                    counts[key] += 1 * multiplier;
                }
                return counts;
            }

            // Validate inventory stock limits (Only for Honors Grab checkouts, not Pre-Orders)
            const isPreorder = selections && selections.preorder_date;
            if (productsData && !isPreorder) {
                for (const item of items) {
                    if (item.product_id === 'catering_event_pack') continue;
                    const dbProd = productsData.find(p => p.id === item.product_id);
                    if (dbProd) {
                        const milkStock = dbProd.options?.milk_stock;
                        if (milkStock) {
                            const counts = getMilkCounts(item);
                            if (milkStock['Regular Milk'] !== null && milkStock['Regular Milk'] !== undefined) {
                                if (milkStock['Regular Milk'] < counts['Regular Milk']) {
                                    return res.status(400).json({ error: `Not enough stock for ${dbProd.name} (Regular Milk). Only ${milkStock['Regular Milk']} left.` });
                                }
                            }
                            if (milkStock['Oat Milk'] !== null && milkStock['Oat Milk'] !== undefined) {
                                if (milkStock['Oat Milk'] < counts['Oat Milk']) {
                                    return res.status(400).json({ error: `Not enough stock for ${dbProd.name} (Oat Milk). Only ${milkStock['Oat Milk']} left.` });
                                }
                            }
                        }
                        if (dbProd.inventory_limit !== null) {
                            const count = (item.selections && Array.isArray(item.selections)) ? item.selections.length : 1;
                            const qtyNeeded = count * parseInt(item.qty || 1);
                            if (dbProd.inventory_limit < qtyNeeded) {
                                return res.status(400).json({ error: `Not enough stock for ${dbProd.name}. Only ${dbProd.inventory_limit} bottles left.` });
                            }
                        }
                    }
                }
            }

            // Catering pricing calculated dynamically in order loop

            // 3. Calculate stamps
            let totalPaidPast = 0;
            let totalFreePast = 0;
            let stampsBefore = 0;
            let stampsAfter = 0;
            let freeRedeemedInCurrent = 0;
            let stampSavings = 0;

            if (customer_phone) {
                const { data: pastOrders } = await supabase
                    .from('cali_orders')
                    .select('selections')
                    .eq('customer_phone', customer_phone)
                    .in('status', ['paid', 'confirmed', 'delivered']);

                if (pastOrders) {
                    for (const order of pastOrders) {
                        const pCart = order.selections?.cart || [];
                        const freeInOrder = parseInt(order.selections?.free_bottles_redeemed || 0);
                        totalFreePast += freeInOrder;

                        for (const item of pCart) {
                            if (item.product_id === 'catering_event_pack') continue;
                            if (typeof item.bottles === 'number') {
                                totalPaidPast += item.bottles;
                            } else {
                                const qty = parseInt(item.qty || 1);
                                const selectionsCount = Array.isArray(item.selections) ? item.selections.length : 1;
                                totalPaidPast += selectionsCount * qty;
                            }
                        }
                    }
                }
                totalPaidPast = Math.max(0, totalPaidPast - totalFreePast);
                stampsBefore = totalPaidPast % 9;

                for (let f = 0; f <= calculatedTotalBottles; f++) {
                    let currentPaid = calculatedTotalBottles - f;
                    let hypotheticalTotalPaid = totalPaidPast + currentPaid;
                    let expectedTotalFree = Math.floor(hypotheticalTotalPaid / 9);
                    let calculatedFree = expectedTotalFree - totalFreePast;
                    
                    if (calculatedFree >= f) {
                        freeRedeemedInCurrent = f;
                    }
                }
                const currentPaid = calculatedTotalBottles - freeRedeemedInCurrent;
                stampsAfter = (totalPaidPast + currentPaid) % 9;
            }

            // Identify cheapest bottles to make free
            let flatBottles = [];
            for (const item of items) {
                if (item.product_id === 'catering_event_pack') continue;
                
                let basePrice = 6.00;
                if (priceMap[item.product_id] !== undefined) {
                    basePrice = priceMap[item.product_id];
                } else if (item.name && (item.name.toLowerCase().includes('black') || item.name.toLowerCase().includes('americano'))) {
                    basePrice = 5.00;
                }
                
                let surcharge = 0;
                let espressoSurcharge = 0;
                if (item.product_id === '83d571c7-5aa8-4efb-b649-0ee286dd463d') {
                    if (item.selections && Array.isArray(item.selections)) {
                        const oatCount = item.selections.filter(s => s.milk === 'Oat Milk').length;
                        surcharge = oatCount * 1.00;
                    }
                } else {
                    let hasOatMilk = false;
                    if (item.selections && Array.isArray(item.selections)) {
                        hasOatMilk = item.selections.some(s => s.milk === 'Oat Milk');
                    } else {
                        hasOatMilk = item.milk === 'Oat Milk';
                    }
                    if (hasOatMilk) surcharge = 1.00;

                    const isMatcha = item.name && item.name.toLowerCase().includes('matcha');
                    const hasEspressoModifier = (item.selections && Array.isArray(item.selections)) ? 
                        item.selections[0].espresso : item.espresso;
                    if (isMatcha) {
                        if (hasEspressoModifier === 'Standard' || hasEspressoModifier === 'Extra') {
                            espressoSurcharge = 1.00;
                        }
                    } else {
                        if (hasEspressoModifier === 'Extra') {
                            espressoSurcharge = 1.00;
                        }
                    }
                }

                const unitPrice = basePrice + surcharge + espressoSurcharge - volumeDiscount;
                for (let q = 0; q < parseInt(item.qty); q++) {
                    flatBottles.push(unitPrice);
                }
            }

            flatBottles.sort((a, b) => a - b);
            for (let idx = 0; idx < Math.min(freeRedeemedInCurrent, flatBottles.length); idx++) {
                stampSavings += flatBottles[idx];
            }

            let stampSavingsDiscounted = stampSavings;
            if (discountPercent > 0) {
                stampSavingsDiscounted = stampSavings * (1 - (discountPercent / 100));
            }

            // Calculate base total
            let baseTotal = 0;
            for (const price of flatBottles) {
                let finalPrice = price;
                if (discountPercent > 0) {
                    finalPrice = price * (1 - (discountPercent / 100));
                }
                baseTotal += finalPrice;
            }
            // Add catering packs
            for (const item of items) {
                if (item.product_id === 'catering_event_pack') {
                    const cateringSize = item.selections ? item.selections.length : 30;
                    let rate = 5.50;
                    if (cateringSize >= 500) rate = 4.20;
                    else if (cateringSize >= 250) rate = 4.50;
                    else if (cateringSize >= 200) rate = 4.60;
                    else if (cateringSize >= 150) rate = 4.80;
                    else if (cateringSize >= 100) rate = 5.00;
                    else if (cateringSize >= 75) rate = 5.20;
                    else if (cateringSize >= 50) rate = 5.40;
                    const basePrice = rate * cateringSize;
                    const oatCount = item.selections ? item.selections.filter(s => s.milk === 'Oat Milk').length : 0;
                    const cateringTotalPrice = basePrice + (oatCount * 1.00);
                    baseTotal += cateringTotalPrice * parseInt(item.qty || 1);
                }
            }

            let calculatedTotal = Math.max(0, baseTotal - stampSavingsDiscounted);
            if (selections && selections.delivery_fee) {
                calculatedTotal += parseFloat(selections.delivery_fee);
            }
            let totalBottlesCount = 0;
            if (selections && selections.cart) {
                selections.cart.forEach(item => {
                    if (item.product_id === 'catering_event_pack') {
                        totalBottlesCount += (item.selections ? item.selections.length : 30) * parseInt(item.qty || 1);
                    } else if (item.product_id === '83d571c7-5aa8-4efb-b649-0ee286dd463d') {
                        totalBottlesCount += 5 * parseInt(item.qty || 1);
                    } else {
                        totalBottlesCount += parseInt(item.qty || 1);
                    }
                });
            }
            const calculatedInsulatedBagQty = Math.floor(totalBottlesCount / 30);

            const updatedSelections = {
                ...selections,
                insulated_bag: calculatedInsulatedBagQty > 0,
                insulated_bag_qty: calculatedInsulatedBagQty,
                free_bottles_redeemed: freeRedeemedInCurrent,
                stamps_before: stampsBefore,
                stamps_after: stampsAfter,
                receipt_image_url: receiptImageUrl
            };

            let updatedNotes = (notes || '[SELF-CHECKOUT ORDER]') + `\n[STAMPS] Redeemed: ${freeRedeemedInCurrent} | Stamps: ${stampsBefore} -> ${stampsAfter}`;
            if (selections && selections.fulfillment_type === 'delivery') {
                updatedNotes += `\n[DELIVERY] Address: ${selections.delivery_address} | Fee: $${parseFloat(selections.delivery_fee).toFixed(2)}`;
            }
            if (selections && selections.fulfillment_type === 'kaiser_route') {
                updatedNotes += `\n[DELIVERY: KAISER ROUTE] Hospital: ${selections.kaiser_hospital} | Dept: ${selections.kaiser_department} | Instructions: ${selections.kaiser_instructions || 'None'}`;
            }
            if (calculatedInsulatedBagQty > 0) {
                updatedNotes += `\n[CATERING OPTION] Insulated Cooler Bag & Ice Packs (x${calculatedInsulatedBagQty}) included (Priced-in)`;
            }
            if (selections && selections.custom_label_message) {
                updatedNotes += `\n[CUSTOM LABELS] Message: "${selections.custom_label_message}"`;
            }

            let initialStatus = 'pending';
            if (selections && selections.payment_method === 'cali_coffee_card') {
                const phone = customer_phone || '';
                const pin = selections.pin ? selections.pin.toString().trim() : '';
                
                // 1. Verify PIN
                const { data: userProfile } = await supabase
                    .from('cali_credits')
                    .select('pin_hash')
                    .eq('phone', phone)
                    .maybeSingle();
                    
                if (!userProfile || !userProfile.pin_hash || userProfile.pin_hash !== pin) {
                    return res.status(400).json({ error: 'Invalid or missing 4-digit Coffee Card PIN' });
                }
                
                // 2. Check active unexpired balance
                const now = new Date().toISOString();
                const { data: loads } = await supabase
                    .from('cali_credit_transactions')
                    .select('amount')
                    .eq('phone', phone)
                    .in('type', ['load', 'bonus'])
                    .gt('expires_at', now);

                const { data: spends } = await supabase
                    .from('cali_credit_transactions')
                    .select('amount')
                    .eq('phone', phone)
                    .eq('type', 'spend');

                const totalLoaded = (loads || []).reduce((sum, row) => sum + parseFloat(row.amount || 0), 0);
                const totalSpent = (spends || []).reduce((sum, row) => sum + parseFloat(row.amount || 0), 0);
                const activeBalance = Math.max(0, totalLoaded - totalSpent);
                
                if (activeBalance < calculatedTotal) {
                    return res.status(400).json({ error: `Insufficient Coffee Card balance (Available: $${activeBalance.toFixed(2)})` });
                }
                
                // 3. Record spend transaction
                await supabase.from('cali_credit_transactions').insert({
                    phone,
                    amount: calculatedTotal,
                    type: 'spend',
                    description: `Order Checkout Payment`,
                    order_id: null
                });
                
                updatedNotes += `\n[PAYMENT] Paid with Cali Coffee Card ($${calculatedTotal.toFixed(2)})`;
                initialStatus = 'paid';
            } else if (selections && (selections.payment_method === 'zelle' || selections.payment_method === 'venmo')) {
                updatedNotes += `\n[PAYMENT: ${selections.payment_method.toUpperCase()}] Sender: ${selections.payment_reference || 'N/A'}`;
            }
            
            const { data, error } = await supabase.from('cali_orders').insert({
                customer_name: customer_name || 'Guest',
                customer_phone: customer_phone || '',
                location_id: location_id === 'home' ? null : location_id,
                total: calculatedTotal,
                status: initialStatus,
                selections: updatedSelections,
                notes: updatedNotes
            }).select().single();

            if (error) throw error;

            // Decrement inventory stock if limits are set (Only for Honors Grab checkouts, not Pre-Orders)
            if (productsData && !isPreorder) {
                for (const item of items) {
                    if (item.product_id === 'catering_event_pack') continue;
                    const dbProd = productsData.find(p => p.id === item.product_id);
                    if (dbProd) {
                        let updatedOptions = dbProd.options;
                        const milkStock = dbProd.options?.milk_stock;
                        let needsOptionsUpdate = false;

                        if (milkStock) {
                            const counts = getMilkCounts(item);
                            const newMilkStock = { ...milkStock };
                            if (milkStock['Regular Milk'] !== null && milkStock['Regular Milk'] !== undefined) {
                                newMilkStock['Regular Milk'] = Math.max(0, milkStock['Regular Milk'] - counts['Regular Milk']);
                                needsOptionsUpdate = true;
                            }
                            if (milkStock['Oat Milk'] !== null && milkStock['Oat Milk'] !== undefined) {
                                newMilkStock['Oat Milk'] = Math.max(0, milkStock['Oat Milk'] - counts['Oat Milk']);
                                needsOptionsUpdate = true;
                            }
                            if (needsOptionsUpdate) {
                                updatedOptions = { ...dbProd.options, milk_stock: newMilkStock };
                            }
                        }

                        let newGlobalStock = dbProd.inventory_limit;
                        let needsGlobalUpdate = false;
                        if (dbProd.inventory_limit !== null) {
                            const count = (item.selections && Array.isArray(item.selections)) ? item.selections.length : 1;
                            const qtyNeeded = count * parseInt(item.qty || 1);
                            newGlobalStock = Math.max(0, dbProd.inventory_limit - qtyNeeded);
                            needsGlobalUpdate = true;
                        }

                        if (needsOptionsUpdate || needsGlobalUpdate) {
                            const updates = {};
                            if (needsGlobalUpdate) updates.inventory_limit = newGlobalStock;
                            if (needsOptionsUpdate) updates.options = updatedOptions;
                            
                            await supabase
                                .from('cali_products')
                                .update(updates)
                                .eq('id', item.product_id);
                        }
                    }
                }
            }

            try {
                const { notifyCaliOrder } = require('./lib/email-service');
                await notifyCaliOrder(data, 'PENDING');
            } catch (notifyErr) {
                console.error("Self-checkout notification error:", notifyErr);
            }

            return res.json(data);
        }

        // 6e. SEND CUSTOMER RECEIPT EMAIL (PUBLIC)
        if (req.method === 'POST' && action === 'send_receipt_email') {
            const { order_id, email, order_data } = req.body;
            if (!email) return res.status(400).json({ error: 'Email is required' });

            let order = order_data;
            if (order_id && !order) {
                const { data: dbOrder } = await supabase.from('cali_orders').select('*').eq('id', order_id).single();
                if (dbOrder) order = dbOrder;
            }

            if (!order) {
                return res.status(404).json({ error: 'Order not found' });
            }

            const { sendCustomerCaliReceipt } = require('./lib/email-service');
            const result = await sendCustomerCaliReceipt(order, email);
            if (result && result.error) {
                return res.status(500).json({ error: result.message || 'Failed to send receipt email' });
            }

            return res.json({ success: true, message: 'Receipt sent successfully' });
        }

        // 6f. GET ORDER FOR RECEIPT (PUBLIC)
        if (req.method === 'GET' && action === 'get_receipt') {
            const orderId = req.query.order_id;
            if (!orderId) return res.status(400).json({ error: 'order_id is required' });
            const { data: order, error } = await supabase.from('cali_orders').select('*').eq('id', orderId).single();
            if (error || !order) return res.status(404).json({ error: 'Order not found' });
            return res.json(order);
        }

        // 6c. CHECK ORDER STATUS
        if (req.method === 'GET' && action === 'check_order_status') {
            if (!isAdmin) return res.status(401).json({ error: 'Unauthorized' });
            const orderId = req.query.order_id;
            if (!orderId) return res.status(400).json({ error: 'order_id parameter is required' });

            const { data: order, error } = await supabase.from('cali_orders').select('status, total, notes').eq('id', orderId).single();
            if (error) throw error;
            return res.json(order);
        }

        // 7. UPDATE ORDER
        if (req.method === 'PATCH' && action === 'update_order' && id) {
            const updates = req.body;
            
            // Handle Automatic Refunds if status is changed to rejected
            if (updates.status === 'rejected' || updates.payment_status === 'rejected') {
                try {
                    // 1. Get the existing order to find Stripe info
                    const { data: order } = await supabase.from('cali_orders').select('*').eq('id', id).single();
                    
                    if (order && (order.status === 'paid' || order.status === 'confirmed')) {
                        // 2. Look for Stripe Session ID in notes
                        const sessionMatch = order.notes?.match(/Stripe Session: (cs_[a-zA-Z0-9_]+)/);
                        const sessionId = sessionMatch ? sessionMatch[1] : null;

                        if (sessionId && process.env.STRIPE_SECRET_KEY) {
                            console.log(`[Refund] Initiating refund for session: ${sessionId}`);
                            const session = await stripe.checkout.sessions.retrieve(sessionId);
                            if (session.payment_intent) {
                                await stripe.refunds.create({
                                    payment_intent: session.payment_intent,
                                    reason: 'requested_by_customer'
                                });
                                updates.status = 'refunded';
                                updates.notes = (order.notes || '') + `\n[REFUNDED] Automatically processed via Admin Reject.`;
                            }
                        }
                    }
                } catch (refundErr) {
                    console.error("Refund failed:", refundErr.message);
                    updates.notes = (updates.notes || '') + `\n[REFUND ERROR] ${refundErr.message}`;
                }
            }

            const { data, error } = await supabase.from('cali_orders').update(updates).eq('id', id).select().single();
            if (error) throw error;
            return res.json(data);
        }

        return res.status(404).json({ error: 'Action not found' });

    } catch (e) {
        console.error("Cali API Error:", e);
        res.status(500).json({ error: e.message });
    }
};
