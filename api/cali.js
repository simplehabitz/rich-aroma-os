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
 
        // 3b. GET DIGITAL STAMPS
        if (req.method === 'GET' && action === 'get_stamps') {
            const { phone } = req.query;
            if (!phone) return res.status(400).json({ error: 'Phone parameter is required' });
            
            // Clean up phone string to match format if needed
            const cleanPhone = phone.replace(/\D/g, '');
            
            const { data: pastOrders, error } = await supabase
                .from('cali_orders')
                .select('selections')
                .eq('customer_phone', phone)
                .in('status', ['paid', 'confirmed', 'delivered']);
                
            if (error) throw error;
            
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
            
            return res.json({
                total_bottles: totalBottles,
                total_free_redeemed: totalFreeRedeemed,
                paid_bottles: paidBottles >= 0 ? paidBottles : 0,
                stamps: currentStamps >= 0 ? currentStamps : 0,
                earned_free: earnedFree >= 0 ? earnedFree : 0
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

        // 7. PRODUCT MANAGEMENT
        if (action === 'products' && (req.method === 'POST' || (req.method === 'PUT' && id))) {
            if (!isAdmin) return res.status(401).json({ error: 'Unauthorized' });

            const { imageBase64, ...productData } = req.body;
            
            if (imageBase64 && imageBase64.startsWith('data:image')) {
                try {
                    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
                    const buffer = Buffer.from(base64Data, 'base64');
                    const mimeType = imageBase64.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/png';
                    const ext = mimeType.split('/')[1] || 'png';
                    const storagePath = `cali_products/PROD_${id || Date.now()}_${Date.now()}.${ext}`;

                    const { error: uploadError } = await supabase.storage
                        .from('menu-images')
                        .upload(storagePath, buffer, { contentType: mimeType, upsert: true });

                    if (!uploadError) {
                        const { data: { publicUrl } } = supabase.storage.from('menu-images').getPublicUrl(storagePath);
                        productData.image_url = publicUrl;
                    }
                } catch (err) {
                    console.error("Image upload failed:", err);
                }
            }

            let result;
            if (req.method === 'POST') {
                result = await supabase.from('cali_products').insert(productData).select().single();
            } else {
                result = await supabase.from('cali_products').update(productData).eq('id', id).select().single();
            }

            if (result.error) throw result.error;
            return res.json(result.data);
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

            const cateringPricing = {
                25: 115.00,
                50: 220.00,
                75: 315.00,
                100: 400.00,
                150: 570.00,
                200: 720.00,
                250: 875.00,
                500: 1600.00
            };

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
                let hasOatMilk = false;
                if (item.selections && Array.isArray(item.selections)) {
                    hasOatMilk = item.selections.some(s => s.milk === 'Oat Milk');
                } else {
                    hasOatMilk = item.milk === 'Oat Milk';
                }
                if (hasOatMilk) surcharge = 1.00;

                const unitPrice = basePrice + surcharge - volumeDiscount;
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
                    const cateringSize = item.selections ? item.selections.length : 25;
                    const basePrice = cateringPricing[cateringSize] || 115.00;
                    baseTotal += basePrice * parseInt(item.qty);
                }
            }

            const calculatedTotal = Math.max(0, baseTotal - stampSavingsDiscounted);

            const updatedSelections = {
                ...selections,
                free_bottles_redeemed: freeRedeemedInCurrent,
                stamps_before: stampsBefore,
                stamps_after: stampsAfter,
                receipt_image_url: receiptImageUrl
            };

            const updatedNotes = (notes || '[SELF-CHECKOUT ORDER]') + `\n[STAMPS] Redeemed: ${freeRedeemedInCurrent} | Stamps: ${stampsBefore} -> ${stampsAfter}`;
            
            const { data, error } = await supabase.from('cali_orders').insert({
                customer_name: customer_name || 'Guest',
                customer_phone: customer_phone || '',
                location_id: location_id === 'home' ? null : location_id,
                total: calculatedTotal,
                status: 'pending',
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
