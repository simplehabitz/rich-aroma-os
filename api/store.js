const { supabase } = require('./lib/supabase');
const { awardPoints, syncMembershipState } = require('./lib/loyalty');
const { describeMenuItemPhoto } = require('./lib/ai-service');

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

    if (req.method === 'OPTIONS') return res.status(200).end();

    // 1. EXTRACT ACTION & ID (Support both /api/store?action=X and /api/orders/:id)
    let action = req.query.action;
    let id = req.query.id;
    
    const urlParts = req.url.split('?')[0].split('/');
    if (!action) {
        if (urlParts.includes('status')) action = 'store_status';
        else if (urlParts.includes('orders')) {
            action = 'orders';
            const ordIdx = urlParts.indexOf('orders');
            if (urlParts[ordIdx + 1]) id = urlParts[ordIdx + 1];
        }
    }

    // Auto-fix for common shift typos
    if (action === 'close-sft') action = 'close-shift';

    const { restaurantId, resId, query: queryParam } = req.query;
    let finalResId = restaurantId || resId || 'rich-aroma';

    // Auto-map names to IDs for partners
    if (finalResId && typeof finalResId === 'string') {
        const lowerId = finalResId.toLowerCase();
        if (lowerId.includes('fradas')) finalResId = 'fradas-bar--grill-445';
        else if (lowerId.includes('tony') || lowerId.includes('cerca')) finalResId = 'tonys-pizza';
        else if (lowerId.includes('meson')) finalResId = 'el-meson';
    }

    try {
        // --- 1. STORE STATUS ---
        if (action === 'store_status' || action === 'status') {
            if (req.method === 'PATCH') {
                const newStatus = req.body?.isOpen ? 'active' : 'closed';
                const { data, error } = await supabase.from('restaurants').update({ status: newStatus }).eq('id', finalResId).select().single();
                if (error) throw error;
                return res.json({ success: true, isOpen: data.status === 'active' });
            }
            
            // Timezone-aware local shift calculations
            const localTimeStr = new Date().toLocaleString("en-US", { timeZone: "America/Tegucigalpa" });
            const localDate = new Date(localTimeStr);
            const localHour = localDate.getHours();
            const localMin = localDate.getMinutes();
            const currentMinOfDay = localHour * 60 + localMin;
            
            let isShiftOpen = true;
            let statusMessage = "";
            
            const { data: resData } = await supabase.from('restaurants').select('status, settings').eq('id', finalResId).maybeSingle();
            const settings = resData?.settings || {};
            const oh = settings.operating_hours;
            
            if (oh && oh.open && oh.close) {
                const parseTimeToMin = (timeStr) => {
                    if (!timeStr) return null;
                    const parts = timeStr.split(':');
                    if (parts.length < 2) return null;
                    const h = parseInt(parts[0], 10);
                    const m = parseInt(parts[1], 10);
                    if (isNaN(h) || isNaN(m)) return null;
                    return h * 60 + m;
                };

                const currentDay = localDate.getDay(); // 0 = Sunday, 1 = Monday, etc.
                const openDays = Array.isArray(oh.open_days) ? oh.open_days.map(Number) : [1, 2, 3, 4, 5, 6, 0]; // Default all days

                if (!openDays.includes(currentDay)) {
                    isShiftOpen = false;
                    statusMessage = "Cerrado hoy por descanso semanal.";
                } else {
                    const openMin = parseTimeToMin(oh.open) ?? 360; 
                    const closeMin = parseTimeToMin(oh.close) ?? 1320; 
                    const midStartMin = parseTimeToMin(oh.midday_close_start);
                    const midEndMin = parseTimeToMin(oh.midday_close_end);

                    const closingBuffer = parseInt(oh.closing_buffer_min) || 0;
                    const effectiveCloseMin = closeMin - closingBuffer;

                    if (currentMinOfDay < openMin || currentMinOfDay >= effectiveCloseMin) {
                        isShiftOpen = false;
                        if (currentMinOfDay >= effectiveCloseMin && currentMinOfDay < closeMin) {
                            statusMessage = `Cocina cerrada. Ya no se aceptan pedidos 15 min antes del cierre.`;
                        } else {
                            statusMessage = `Cerrado. Abrimos a las ${oh.open}.`;
                        }
                    } else if (midStartMin !== null && midEndMin !== null && currentMinOfDay >= midStartMin && currentMinOfDay < midEndMin) {
                        isShiftOpen = false;
                        statusMessage = `Cerrado por preparación. Reabrimos a las ${oh.midday_close_end}.`;
                    }
                }
            } else if (finalResId === 'rich-aroma') {
                // Fallback to legacy hardcoded shifts
                if (localHour >= 14 && localHour < 16) {
                    isShiftOpen = false;
                    statusMessage = "Cerrado por preparación. ¡Te esperamos a las 4:00 PM para Rico's Smash & Social!";
                } else if (localHour >= 22 || localHour < 6) {
                    isShiftOpen = false;
                    statusMessage = "Cerrado. Abrimos a las 6:00 AM.";
                }
            }

            const isOpen = resData ? (resData.status === 'active' && isShiftOpen) : isShiftOpen;
            return res.json({ isOpen, statusMessage, activeShift: { id: 'shift_today' } });
        }

        // --- 2. ORDERS (GET & UPDATE) ---
        if (action === 'orders' || action === 'order_update') {
            if (req.method === 'PATCH' || (req.method === 'POST' && id)) {
                const targetId = id || req.body?.orderId;
                const { status, notes, subtotal, discount, total, paymentMethod, secondaryPaymentMethod, customerId, shiftId, items } = req.body || {};
                if (!targetId) return res.status(400).json({ error: "Order ID required" });
                
                const updates = {};
                if (status) updates.status = status;
                if (notes) updates.notes = notes;
                if (items) updates.items = items;
                if (subtotal !== undefined) updates.subtotal = parseFloat(subtotal);
                if (discount !== undefined) updates.discount = parseFloat(discount);
                if (total !== undefined) updates.total = parseFloat(total);
                if (paymentMethod) updates.payment_method = paymentMethod;
                if (secondaryPaymentMethod) updates.secondary_payment_method = secondaryPaymentMethod;
                if (customerId) updates.customer_id = customerId;
                if (shiftId) updates.shift_id = shiftId;

                const { data, error } = await supabase.from('orders').update(updates).eq('id', targetId).select().single();
                if (error) throw error;
                return res.json({ success: true, order: data });
            }
            if (req.method === 'GET') {
                let query = supabase.from('orders').select('*, customers(name, phone)');
                if (id) {
                    const { data, error } = await query.eq('id', id).maybeSingle();
                    if (error) throw error;
                    return res.json(data);
                }
                const cId = req.query.customerId;
                if (cId) {
                    query = query.eq('customer_id', cId);
                } else {
                    query = query.eq('restaurant_id', finalResId);
                }
                const { data, error } = await query.order('created_at', { ascending: false }).limit(50);
                if (error) throw error;
                return res.json({ orders: data || [] });
            } else if (req.method === 'POST') {
                const { items, total, subtotal, discount, paymentMethod, customerId, notes, fulfillment, guestPhone, shiftId } = req.body || {};
                
                let ricoAmountPaid = 0;
                let allowanceUsedThisOrder = 0;

                // --- 1. EMPLOYEE ALLOWANCE LOGIC ---
                if (customerId && paymentMethod === 'rico_balance') {
                    const { data: cust } = await supabase.from('customers').select('*').eq('id', customerId).single();
                    if (cust) {
                        const today = new Date().toISOString().split('T')[0];
                        const lastReset = cust.last_allowance_date || '';
                        let currentUsed = lastReset === today ? (parseFloat(cust.allowance_used_today) || 0) : 0;
                        const limit = parseFloat(cust.daily_allowance) || 0;
                        
                        if (limit > 0) {
                            const remainingAllowance = Math.max(0, limit - currentUsed);
                            allowanceUsedThisOrder = Math.min(total, remainingAllowance);
                            
                            // Update the allowance tracker
                            await supabase.from('customers').update({
                                allowance_used_today: currentUsed + allowanceUsedThisOrder,
                                last_allowance_date: today
                            }).eq('id', customerId);

                            console.log(`[Allowance] Order Total: L.${total}. Using L.${allowanceUsedThisOrder} from daily allowance.`);
                        }

                        // --- 2. REMAINING BALANCE FROM REAL RICO CASH ---
                        const remainingToPay = total - allowanceUsedThisOrder;
                        if (remainingToPay > 0) {
                            const realBalance = parseFloat(cust.rico_balance) || 0;
                            if (realBalance < remainingToPay) throw new Error("Saldo insuficiente en Rico Cash");
                            
                            await supabase.from('customers').update({
                                rico_balance: realBalance - remainingToPay
                            }).eq('id', customerId);
                            
                            ricoAmountPaid = remainingToPay;
                            console.log(`[RicoCash] Charging remaining L.${remainingToPay} to real balance.`);
                        }
                    }
                }

                const { data, error } = await supabase.from('orders').insert({
                    id: 'ord_' + Date.now(),
                    order_number: Math.floor(Date.now() / 1000) - 1769000000,
                    items, 
                    total: parseFloat(total), 
                    subtotal: parseFloat(subtotal || total), 
                    discount: parseFloat(discount || 0), 
                    payment_method: paymentMethod, 
                    customer_id: customerId, 
                    shift_id: shiftId,
                    rico_amount_paid: ricoAmountPaid + allowanceUsedThisOrder,
                    notes: `[FULFILLMENT: ${fulfillment || 'pickup'}] ` + (guestPhone ? `[TEL: ${guestPhone}] ` : '') + (notes || '') + (allowanceUsedThisOrder > 0 ? ` [ALLOWANCE: L.${allowanceUsedThisOrder.toFixed(2)}]` : ''), 
                    status: req.body?.status || 'pending', 
                    restaurant_id: finalResId,
                    scheduled_for: req.body?.scheduled_for || null
                }).select().single();
                if (error) throw error;

                // --- 2.5 FIFO BATCH INVENTORY DEDUCTION (JSONB fallback) ---
                if (items && Array.isArray(items)) {
                    try {
                        const { data: resData } = await supabase.from('restaurants').select('settings').eq('id', finalResId).single();
                        if (resData) {
                            const settings = resData.settings || {};
                            const productInventory = settings.product_inventory || {};
                            const batches = settings.batches || [];
                            let settingsUpdated = false;

                            for (const orderItem of items) {
                                const itemId = orderItem.id;
                                const qtyOrdered = parseInt(orderItem.qty) || 1;

                                const itemConfig = productInventory[itemId];
                                if (itemConfig && itemConfig.is_unlimited === false) {
                                    let remainingToDeduct = qtyOrdered;
                                    settingsUpdated = true;

                                    // Filter active batches for this item and sort by oldest first
                                    const itemBatches = batches.filter(b => b.menu_item_id === itemId && b.quantity > 0);
                                    itemBatches.sort((a, b) => new Date(a.expires_at) - new Date(b.expires_at));

                                    for (const batch of itemBatches) {
                                        if (remainingToDeduct <= 0) break;
                                        const deductFromBatch = Math.min(batch.quantity, remainingToDeduct);
                                        batch.quantity -= deductFromBatch;
                                        remainingToDeduct -= deductFromBatch;
                                    }

                                    // Re-calculate remaining stock
                                    const now = new Date();
                                    const validBatches = batches.filter(b => b.menu_item_id === itemId && new Date(b.expires_at) > now);
                                    const newStockQty = validBatches.reduce((sum, b) => sum + b.quantity, 0);

                                    productInventory[itemId].stock_quantity = newStockQty;

                                    // Sync item availability in menu_items table
                                    const isAvailable = newStockQty > 0;
                                    await supabase.from('menu_items')
                                        .update({ available: isAvailable })
                                        .eq('id', itemId);
                                }
                            }

                            if (settingsUpdated) {
                                settings.product_inventory = productInventory;
                                settings.batches = batches;
                                await supabase.from('restaurants').update({ settings }).eq('id', finalResId);
                            }
                        }
                    } catch(e) {
                        console.error("[FIFO JSONB error]", e);
                    }
                }

                if (customerId && finalResId === 'rich-aroma') {
                    try {
                        await awardPoints(customerId, total, paymentMethod, supabase);
                        
                        // Check if this is the customer's first completed order
                        const { data: priorOrders } = await supabase.from('orders').select('id').eq('customer_id', customerId);
                        if (priorOrders && priorOrders.length <= 1) {
                            
                            // 1. Process Welcome Wheel Cashback (L. 50 or L. 25)
                            if (req.body.welcomePromo === 'CASHBACK_50' || req.body.welcomePromo === 'CASHBACK_25') {
                                const cashbackAmount = req.body.welcomePromo === 'CASHBACK_50' ? 50.00 : 25.00;
                                const { data: cust } = await supabase.from('customers').select('rico_balance').eq('id', customerId).single();
                                if (cust) {
                                    const newBal = (parseFloat(cust.rico_balance) || 0) + cashbackAmount;
                                    await supabase.from('customers').update({ rico_balance: newBal }).eq('id', customerId);
                                    console.log(`[Promo] Welcomed customer ${customerId} with L.${cashbackAmount} cashback.`);
                                }
                            }
                            
                            // 2. Process Referral Rewards (Double-sided L. 30 reward)
                            const { data: custProfile } = await supabase.from('customers').select('referral_code').eq('id', customerId).single();
                            if (custProfile && custProfile.referral_code) {
                                const refPhone = custProfile.referral_code.trim();
                                
                                // Reward Referrer
                                const { data: referrer } = await supabase.from('customers').select('id, rico_balance').eq('phone', refPhone).maybeSingle();
                                if (referrer) {
                                    const refBal = (parseFloat(referrer.rico_balance) || 0) + 30.00;
                                    await supabase.from('customers').update({ rico_balance: refBal }).eq('id', referrer.id);
                                    console.log(`[Referral] Credited L.30 reward to referrer: ${referrer.id}`);
                                }
                                
                                // Reward Referee (new customer)
                                const { data: newCust } = await supabase.from('customers').select('rico_balance').eq('id', customerId).single();
                                if (newCust) {
                                    const newCustBal = (parseFloat(newCust.rico_balance) || 0) + 30.00;
                                    await supabase.from('customers').update({ rico_balance: newCustBal }).eq('id', customerId);
                                    console.log(`[Referral] Credited L.30 reward to Referee: ${customerId}`);
                                }
                            }
                        }
                    } catch(e) {
                        console.error("[Launch Promo Error]", e);
                    }
                }
                return res.json(data);
            }
        }

        // --- 3. CASH / SHIFT ACTIONS ---
        if (action === 'current-shift' || action === 'current_shift') {
            const { data: shift } = await supabase.from('cash_shifts').select('*').eq('status', 'open').eq('restaurant_id', 'rich-aroma').order('opened_at', { ascending: false }).limit(1).maybeSingle();
            return res.json({ shift });
        }

        if (action === 'close-shift-preview') {
            const { shiftId } = req.query;
            if (!shiftId) return res.status(400).json({ error: "Shift ID required" });
            
            try {
                const { data: shift } = await supabase.from('cash_shifts').select('*').eq('id', shiftId).single();
                if (!shift) throw new Error('Shift not found');

                // 1. Fetch all orders that happened since the shift started
                const { data: allToday, error: ordersErr } = await supabase.from('orders')
                    .select('total, payment_method, secondary_payment_method, rico_amount_paid, shift_id, created_at')
                    .eq('restaurant_id', 'rich-aroma')
                    .gte('created_at', shift.opened_at)
                    .not('status', 'eq', 'cancelled');
                
                if (ordersErr) throw ordersErr;

                // 2. Filter for orders linked to this shift OR orders with no shift_id but within timeframe
                const shiftOrders = (allToday || []).filter(o => 
                    o.shift_id === shiftId || (!o.shift_id && o.created_at >= shift.opened_at)
                );

                const sales = { cash: 0, card: 0, transfer: 0, rico: 0 };
                (shiftOrders || []).forEach(o => {
                    const finalTotal = parseFloat(o.total) || 0;
                    const r = parseFloat(o.rico_amount_paid) || 0;
                    sales.rico += r; 
                    const net = finalTotal - r;

                    const method = o.secondary_payment_method || o.payment_method;
                    if (method === 'cash') sales.cash += net;
                    else if (method === 'card') sales.card += net;
                    else if (method === 'transfer') sales.transfer += net;
                });
                
                const { data: rTxns, error: txnsErr } = await supabase.from('cash_transactions').select('amount, reason').eq('shift_id', shiftId);
                if (txnsErr) throw txnsErr;

                let petty = 0;
                (rTxns || []).forEach(t => { 
                    const amt = parseFloat(t.amount) || 0;
                    // In this DB, Negative = payout, Positive = drop
                    petty += amt; 
                });

                return res.json({ sales, transactions: petty });
            } catch (err) {
                console.error("[Preview Error]", err);
                return res.status(500).json({ error: err.message });
            }
        }

        if (action === 'close-shift') {
            const { shiftId, closingAmount, declaredCard, declaredTransfer, notes } = req.body || {};
            if (!shiftId) return res.status(400).json({ error: "Shift ID required" });

            try {
                const { data: shift, error: shiftErr } = await supabase.from('cash_shifts').select('*').eq('id', shiftId).single();
                if (shiftErr || !shift) throw new Error("No se encontró la sesión");

                // 1. Fetch data for the final report
                const { data: allOrders, error: ordersErr } = await supabase.from('orders')
                    .select('total, payment_method, secondary_payment_method, rico_amount_paid, shift_id, created_at')
                    .eq('restaurant_id', 'rich-aroma')
                    .gte('created_at', shift.opened_at)
                    .not('status', 'eq', 'cancelled');
                
                if (ordersErr) throw ordersErr;

                const shiftOrders = (allOrders || []).filter(o => 
                    o.shift_id === shiftId || (!o.shift_id && o.created_at >= shift.opened_at)
                );

                const sales = { cash: 0, card: 0, transfer: 0, rico: 0 };
                (shiftOrders || []).forEach(o => {
                    const finalTotal = parseFloat(o.total) || 0; 
                    const r = parseFloat(o.rico_amount_paid) || 0;
                    sales.rico += r; 
                    const net = finalTotal - r;

                    const method = o.secondary_payment_method || o.payment_method;
                    if (method === 'cash') sales.cash += net;
                    else if (method === 'card') sales.card += net;
                    else if (method === 'transfer') sales.transfer += net;
                });

                const { data: rTxns, error: txnsErr } = await supabase.from('cash_transactions').select('amount, reason').eq('shift_id', shiftId);
                if (txnsErr) throw txnsErr;

                let petty = 0;
                (rTxns || []).forEach(t => { 
                    const amt = parseFloat(t.amount) || 0;
                    petty += amt; 
                });

                const opening = parseFloat(shift.opening_amount) || 0;
                const expected = opening + sales.cash + petty;
                const declared = parseFloat(closingAmount) || 0;
                const diff = declared - expected;

                const auditNotes = JSON.stringify({
                    user_notes: notes || '',
                    declared_card: parseFloat(declaredCard) || 0,
                    declared_transfer: parseFloat(declaredTransfer) || 0
                });

                const { data: updated, error: closeErr } = await supabase.from('cash_shifts').update({ 
                    status: 'closed', 
                    closed_at: new Date().toISOString(), 
                    closing_amount_declared: declared,
                    expected_amount: expected,
                    discrepancy: diff,
                    notes: auditNotes 
                }).eq('id', shiftId).select().single();
                
                if (closeErr) throw closeErr;

                return res.json({ 
                    success: true, 
                    shift: updated, 
                    report: { 
                        opening_amount: opening, 
                        sales, 
                        transactions: petty, 
                        declared: { cash: declared, card: declaredCard, transfer: declaredTransfer },
                        expected_amount: expected,
                        discrepancy: diff
                    } 
                });
            } catch (err) {
                console.error("[Close Shift Error]", err);
                return res.status(500).json({ error: err.message });
            }
        }

        if (action === 'open-shift') {
            const { openingAmount, employeeId } = req.body || {};
            
            // Safety check: Is there already an open shift?
            const { data: existing } = await supabase.from('cash_shifts').select('*').eq('status', 'open').eq('restaurant_id', 'rich-aroma').maybeSingle();
            if (existing) {
                console.log("[Shift] Returning existing open shift:", existing.id);
                return res.json({ success: true, ...existing });
            }

            const { data, error } = await supabase.from('cash_shifts').insert({ opening_amount: parseFloat(openingAmount) || 0, employee_id: employeeId || 'master', restaurant_id: finalResId, status: 'open', opened_at: new Date().toISOString() }).select().single();
            if (error) throw error;
            return res.json({ success: true, ...data });
        }

        if (action === 'verify-pin') {
            const { pin } = req.body || {};
            if (pin === '4574' || pin === '3620') return res.json({ success: true, employee: { id: 'master', name: 'Admin', role: 'admin', restaurant_id: 'rich-aroma' } });
            
            const { data: emp } = await supabase.from('employees').select('*').eq('pin', pin).eq('active', true).maybeSingle();
            if (emp) return res.json({ success: true, employee: emp });

            // Fallback: Check if matching master PIN exists in restaurants settings JSONB
            const { data: resList, error: resErr } = await supabase.from('restaurants').select('*').contains('settings', { pin: pin });
            if (resList && resList.length > 0) {
                const resData = resList[0];
                return res.json({
                    success: true,
                    employee: {
                        id: 'master',
                        name: resData.name,
                        role: 'admin',
                        restaurant_id: resData.id
                    }
                });
            }

            return res.status(401).json({ error: "PIN Inválido" });
        }

        // --- 4. CUSTOMERS ---
        if (action === 'customer_login') {
            const { phone, pin } = req.body || {};
            if (!phone || !pin) return res.status(400).json({ error: "Phone and PIN required" });

            const cleanPhone = phone.replace(/\D/g, '');
            let phoneToSearch = cleanPhone;
            if (cleanPhone.length === 8) phoneToSearch = `504${cleanPhone}`;

            // 1. Try search with 504 prefix
            let { data: customer, error } = await supabase.from('customers')
                .select('*')
                .eq('phone', phoneToSearch)
                .maybeSingle();

            if (error) throw error;

            // 2. Fallback to exact raw input if nothing found
            if (!customer) {
                const { data: fallbackCustomer, error: fallbackError } = await supabase.from('customers')
                    .select('*')
                    .eq('phone', cleanPhone)
                    .maybeSingle();
                
                if (fallbackError) throw fallbackError;
                customer = fallbackCustomer;
            }

            if (!customer) return res.status(404).json({ error: "Cuenta no encontrada" });
            if (customer.pin !== pin) return res.status(401).json({ error: "PIN Incorrecto" });

            const synced = await syncMembershipState(customer, supabase);
            return res.json({ success: true, user: synced });
        }

        if (action === 'customer_link_phone') {
            const { walletAddress, email, phone, pin } = req.body || {};
            if (!walletAddress || !phone || !pin) return res.status(400).json({ error: "Wallet address, phone, and pin are required" });

            const cleanPhone = phone.replace(/\D/g, '');
            let phoneToStore = cleanPhone;
            if (cleanPhone.length === 8) phoneToStore = `504${cleanPhone}`;

            // Check if phone number already linked to a different wallet
            const { data: existing } = await supabase.from('customers')
                .select('*')
                .eq('phone', phoneToStore)
                .maybeSingle();

            let pendingBalance = 0;
            let pendingPoints = 0;

            if (existing && existing.id !== walletAddress) {
                // If it's a pending placeholder account created during a referral transfer, merge it!
                if (existing.id.startsWith('cust_pending_') || (existing.tags && existing.tags.includes('pending_onboarding'))) {
                    pendingBalance = parseFloat(existing.rico_balance) || 0;
                    pendingPoints = parseInt(existing.points) || 0;

                    // Delete the placeholder account
                    const { error: delErr } = await supabase.from('customers').delete().eq('id', existing.id);
                    if (delErr) {
                        console.error("[customer_link_phone] Failed to delete pending placeholder:", delErr);
                        return res.status(500).json({ error: "Error al unificar cuenta referida." });
                    }

                    // Update any references to point to the new wallet ID
                    try {
                        await Promise.all([
                            supabase.from('balance_history').update({ customer_id: walletAddress }).eq('customer_id', existing.id),
                            supabase.from('orders').update({ customer_id: walletAddress }).eq('customer_id', existing.id)
                        ]);
                    } catch (syncErr) {
                        console.error("[customer_link_phone] Data sync warning:", syncErr);
                    }
                } else {
                    return res.status(400).json({ error: "Este número de teléfono ya está vinculado a otra cuenta." });
                }
            }

            // Get existing customer to preserve points/visits
            const { data: existingCustomer } = await supabase.from('customers')
                .select('*')
                .eq('id', walletAddress)
                .maybeSingle();

            // Check if already verified
            const isVerified = existingCustomer?.tags?.includes('verified') || false;
            const verifyCode = 'QE-' + String(Math.floor(1000 + Math.random() * 9000));
            const newTags = isVerified ? (existingCustomer.tags || ['verified']) : ['unverified', verifyCode];

            // Upsert profile (merging any pending balance and points from the referral)
            const finalBalance = (parseFloat(existingCustomer?.rico_balance) || 0) + pendingBalance;
            const finalPoints = (parseInt(existingCustomer?.points) || 0) + pendingPoints;

            const { data: customer, error } = await supabase.from('customers')
                .upsert({
                    id: walletAddress,
                    email: email || existingCustomer?.email || null,
                    phone: phoneToStore,
                    pin: pin,
                    name: existingCustomer?.name || (email ? email.split('@')[0] : 'Socio QuimiEats'),
                    rico_balance: finalBalance,
                    points: finalPoints,
                    visits: existingCustomer?.visits || 0,
                    tags: newTags
                })
                .select()
                .single();

            if (error) throw error;
            return res.json({ success: true, customer, needsVerification: !isVerified, verifyCode });
        }

        if (action === 'load_balance' && req.method === 'POST') {
            const id = req.query.id || req.body.id;
            const { amount } = req.body;
            if (!id || !amount) return res.status(400).json({ error: "Missing ID or amount" });

            const { data: customer, error: fetchErr } = await supabase.from('customers').select('*').eq('id', id).single();
            if (fetchErr || !customer) return res.status(404).json({ error: "Customer not found" });

            const bonus = customer.is_vip ? parseFloat(amount) * 0.10 : 0;
            const reloadAmount = parseFloat(amount) + bonus;

            const newBalance = (parseFloat(customer.rico_balance) || 0) + reloadAmount;
            const { data, error } = await supabase.from('customers').update({ rico_balance: newBalance }).eq('id', id).select().single();
            
            if (error) return res.status(500).json({ error: error.message });
            return res.json({ success: true, newBalance, customer: data });
        }

        if (action === 'purchase_membership' && req.method === 'POST') {
            const customerId = req.query.id;
            if (!customerId) return res.status(400).json({ error: "Customer ID required" });

            const { data: customer, error: fetchErr } = await supabase.from('customers').select('*').eq('id', customerId).single();
            if (fetchErr || !customer) return res.status(404).json({ error: "Customer not found" });

            const VIP_PRICE = 250;
            if ((customer.rico_balance || 0) < VIP_PRICE) {
                return res.status(400).json({ error: "Saldo Rico Cash insuficiente (L 250 requeridos)" });
            }

            const { data: updated, error: updateErr } = await supabase.from('customers')
                .update({ 
                    is_vip: true, 
                    rico_balance: customer.rico_balance - VIP_PRICE,
                    vip_expiry: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
                })
                .eq('id', customerId)
                .select().single();

            if (updateErr) throw updateErr;
            return res.json({ success: true, customer: updated });
        }

        if (action === 'customer_transfer') {
            const { senderId, recipientPhone, amountHNL } = req.body || {};
            if (!senderId || !recipientPhone || !amountHNL) {
                return res.status(400).json({ error: "Datos incompletos para la transferencia" });
            }

            const transferAmt = parseFloat(amountHNL);
            if (isNaN(transferAmt) || transferAmt <= 0) {
                return res.status(400).json({ error: "Monto inválido" });
            }

            // 1. Fetch Sender
            const { data: sender, error: senderErr } = await supabase.from('customers').select('*').eq('id', senderId).single();
            if (senderErr || !sender) {
                return res.status(404).json({ error: "Remitente no encontrado" });
            }

            const senderBal = parseFloat(sender.rico_balance) || 0;
            if (senderBal < transferAmt) {
                return res.status(400).json({ error: "Saldo insuficiente" });
            }

            // 2. Fetch Recipient (Phone format clean-up)
            const cleanPhone = recipientPhone.replace(/\D/g, '');
            let phoneToSearch = cleanPhone;
            if (cleanPhone.length === 8) phoneToSearch = `504${cleanPhone}`;

            let recipient = null;
            let isNewOnboarding = false;

            const { data: existingRec, error: recErr } = await supabase.from('customers').select('*').eq('phone', phoneToSearch).maybeSingle();
            
            if (existingRec) {
                recipient = existingRec;
                if (recipient.tags && recipient.tags.includes('privacy_private')) {
                    return res.status(400).json({ error: "Este usuario tiene desactivada la recepción de transferencias (cuenta privada)." });
                }
            } else {
                isNewOnboarding = true;
                const pendingId = 'cust_pending_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
                const { data: newCust, error: createErr } = await supabase.from('customers').insert({
                    id: pendingId,
                    phone: phoneToSearch,
                    name: 'Invitado (' + phoneToSearch.slice(-4) + ')',
                    rico_balance: 0,
                    tags: ['pending_onboarding']
                }).select().single();

                if (createErr || !newCust) {
                    console.error("Failed to create pending customer:", createErr);
                    return res.status(500).json({ error: "No se pudo preparar la transferencia para este número." });
                }
                recipient = newCust;
            }

            if (sender.id === recipient.id) {
                return res.status(400).json({ error: "No puedes transferirte a ti mismo" });
            }

            // 3. Deduct from Sender and credit Recipient
            const newSenderBal = senderBal - transferAmt;
            const newRecBal = (parseFloat(recipient.rico_balance) || 0) + transferAmt;

            const { error: sendUpdErr } = await supabase.from('customers').update({ rico_balance: newSenderBal }).eq('id', sender.id);
            if (sendUpdErr) throw sendUpdErr;

            const { error: recUpdErr } = await supabase.from('customers').update({ rico_balance: newRecBal }).eq('id', recipient.id);
            if (recUpdErr) {
                // Rollback sender balance on failure
                await supabase.from('customers').update({ rico_balance: senderBal }).eq('id', sender.id);
                throw recUpdErr;
            }

            // 4. Log to balance history if it exists
            try {
                await supabase.from('balance_history').insert([
                    { customer_id: sender.id, change: -transferAmt, type: 'transfer_out', notes: `Enviado a ${recipient.name || recipient.phone}` },
                    { customer_id: recipient.id, change: transferAmt, type: 'transfer_in', notes: `Recibido de ${sender.name || sender.phone}` }
                ]);
            } catch(e) { console.error("History logging failed", e); }

            const inviteLink = isNewOnboarding 
                ? `https://wa.me/${phoneToSearch}?text=${encodeURIComponent(`¡Hola! Te he enviado L. ${transferAmt.toFixed(2)} en QuimiEats. Regístrate aquí para reclamar tus fondos: https://quimieats.com/quimieats.html?signup=true&phone=${phoneToSearch.slice(-8)}`)}`
                : null;

            return res.json({ 
                success: true, 
                senderBalance: newSenderBal,
                recipientName: recipient.name || recipient.phone,
                isNewOnboarding,
                inviteLink
            });
        }

        if (action === 'customer_by_phone' || action === 'customer_by_query') {
            const query = req.query.query || req.query.phone;
            if (!query) return res.status(400).json({ error: "Query required" });

            // 1. Try exact phone match (with or without 504) or ID or Name
            const cleanQuery = query.replace(/\D/g, '');
            let phoneQuery = query;
            if (cleanQuery.length === 8) phoneQuery = `504${cleanQuery}`;

            const { data: results, error } = await supabase.from('customers')
                .select('*')
                .or(`phone.eq.${query},phone.eq.${phoneQuery},name.ilike.%${query}%,id.eq.${query}`)
                .order('points', { ascending: false }) // Return most active first
                .limit(5); // Get a few to be safe
            
            if (error) throw error;
            if (!results || results.length === 0) return res.status(404).json({ error: "Customer not found" });

            // For now, take the best match (first one)
            const synced = await syncMembershipState(results[0], supabase);
            return res.json(synced);
        }

        if (action === 'customer_profile') {
            const searchId = id || req.query.id;
            const phone = req.query.phone;
            
            if (!searchId && !phone) return res.status(400).json({ error: "ID or Phone required" });

            let query = supabase.from('customers').select('*');
            
            if (searchId) {
                query = query.eq('id', searchId);
            } else {
                const cleanPhone = phone.replace(/\D/g, '');
                query = query.or(`phone.eq.${cleanPhone},phone.eq.504${cleanPhone}`);
            }

            const { data, error } = await query.maybeSingle();

            if (error) throw error;
            if (!data) return res.status(404).json({ error: "Customer not found" });

            const synced = await syncMembershipState(data, supabase);
            return res.json(synced);
        }

        if (action === 'customer_list') {
            const { data, error } = await supabase.from('customers')
                .select('*')
                .order('created_at', { ascending: false });
            if (error) throw error;
            return res.json(data);
        }

        if (action === 'customer_delete') {
            const targetId = id || req.query.id;
            if (!targetId) return res.status(400).json({ error: "ID required" });

            // --- CLEANUP RELATED DATA FIRST ---
            // These tables have foreign keys to customers. To delete a customer, 
            // we must either CASCADE (DB level) or delete manually here.
            try {
                // 1. Anonymize orders (keep the sales data, just remove the link to the customer)
                await supabase.from('orders').update({ customer_id: null }).eq('customer_id', targetId);

                // 2. Delete strictly personal/loyalty data
                await Promise.all([
                    supabase.from('customer_points').delete().eq('customer_id', targetId),
                    supabase.from('reward_claims').delete().eq('customer_id', targetId),
                    supabase.from('balance_history').delete().eq('customer_id', targetId),
                    supabase.from('membership_billing_events').delete().eq('customer_id', targetId)
                ]);
            } catch (cleanupErr) {
                console.warn("[CustomerDelete] Cleanup warning:", cleanupErr.message);
            }

            const { error } = await supabase.from('customers')
                .delete()
                .eq('id', targetId);

            if (error) throw error;
            return res.json({ success: true });
        }

        if (action === 'customer_create') {
            const { name, phone, email, tags, birthday, customer_type, pin } = req.body || {};
            const cleanPhone = (phone || '').replace(/\D/g, '');
            let phoneToStore = cleanPhone;
            if (cleanPhone.length === 8) phoneToStore = `504${cleanPhone}`;
            
            const newTags = tags || [];
            if (customer_type === 'employee' || customer_type === 'Employee') {
                if (!newTags.includes('Employee')) newTags.push('Employee');
            } else if (customer_type === 'senior') {
                if (!newTags.includes('Tercera Edad')) newTags.push('Tercera Edad');
            } else if (customer_type === 'senior_plus') {
                if (!newTags.includes('Cuarta Edad')) newTags.push('Cuarta Edad');
            } else if (customer_type === 'hero') {
                if (!newTags.includes('Hero')) newTags.push('Hero');
            }

            // Check if there is an existing pending profile
            const { data: existing } = await supabase.from('customers').select('*').eq('phone', phoneToStore).maybeSingle();
            
            if (existing) {
                if (existing.tags && existing.tags.includes('pending_onboarding')) {
                    const finalTags = (existing.tags || []).filter(t => t !== 'pending_onboarding');
                    newTags.forEach(t => { if (!finalTags.includes(t)) finalTags.push(t); });
                    
                    const { data: updated, error: updErr } = await supabase.from('customers').update({
                        name: name || existing.name,
                        email: email || existing.email,
                        pin: pin || existing.pin,
                        tags: finalTags,
                        birthday: birthday || existing.birthday
                    }).eq('id', existing.id).select().single();
                    
                    if (updErr) throw updErr;
                    return res.json(updated);
                } else {
                    return res.status(400).json({ error: "Este número de teléfono ya está registrado." });
                }
            }

            const { data, error } = await supabase.from('customers').insert({
                id: 'cust_' + Date.now(),
                name: name || 'Nuevo Cliente',
                phone: phoneToStore,
                email,
                pin,
                tags: newTags,
                birthday,
                points: 0,
                rico_balance: 0
            }).select().single();

            if (error) throw error;
            return res.json(data);
        }

        if (action === 'customer_update') {
            const targetId = id || req.query.id;
            if (!targetId) return res.status(400).json({ error: "ID required" });

            const { data, error } = await supabase.from('customers')
                .update(req.body)
                .eq('id', targetId)
                .select()
                .single();

            if (error) throw error;
            return res.json(data);
        }

        // --- RESTAURANT-SPECIFIC STAMP LOYALTY CARDS ---
        if (action === 'get_customer_stamp_cards') {
            const phone = req.query.phone || req.body?.phone;
            if (!phone) return res.status(400).json({ error: "Phone number is required" });

            const cleanPhone = phone.replace(/\D/g, '');
            const phoneVariants = [cleanPhone];
            if (cleanPhone.length === 8) phoneVariants.push(`504${cleanPhone}`);
            if (cleanPhone.startsWith('504') && cleanPhone.length === 11) phoneVariants.push(cleanPhone.slice(3));

            const { data: cards, error } = await supabase.from('restaurant_loyalty_cards')
                .select('*')
                .in('customer_phone', phoneVariants);

            if (error) {
                const isMissingTable = error.code === 'PGRST205' || (error.message && (error.message.includes('restaurant_loyalty_cards') || error.message.includes('relation')));
                if (!isMissingTable) {
                    throw error;
                }
            }

            // Fetch restaurant details for these cards
            const resIds = (cards || []).map(c => c.restaurant_id);
            let restaurantsMap = {};
            if (resIds.length > 0) {
                const { data: resList } = await supabase.from('restaurants')
                    .select('id, name, logo_url, category')
                    .in('id', resIds);
                (resList || []).forEach(r => { restaurantsMap[r.id] = r; });
            }

            const formattedCards = (cards || []).map(card => ({
                id: card.id,
                restaurant_id: card.restaurant_id,
                restaurant_name: restaurantsMap[card.restaurant_id]?.name || card.restaurant_id.replace(/-/g, ' ').toUpperCase(),
                logo_url: restaurantsMap[card.restaurant_id]?.logo_url || '/icon-192.png',
                category: restaurantsMap[card.restaurant_id]?.category || 'Restaurante',
                stamps_count: card.stamps_count || 0,
                stamps_goal: card.stamps_goal || 6,
                rewards_earned: card.rewards_earned || 0,
                rewards_redeemed: card.rewards_redeemed || 0,
                reward_description: card.reward_description || '1 Producto Gratis',
                updated_at: card.updated_at
            }));

            return res.json({ success: true, cards: formattedCards });
        }

        if (action === 'redeem_stamp_reward' && req.method === 'POST') {
            const { phone, restaurantId, cardId } = req.body || {};
            if (!restaurantId && !cardId) return res.status(400).json({ error: "restaurantId or cardId is required" });

            let query = supabase.from('restaurant_loyalty_cards').select('*');
            if (cardId) {
                query = query.eq('id', cardId);
            } else {
                const cleanPhone = (phone || '').replace(/\D/g, '');
                query = query.eq('restaurant_id', restaurantId).eq('customer_phone', cleanPhone);
            }

            const { data: card, error } = await query.maybeSingle();
            if (error || !card) return res.status(404).json({ error: "Tarjeta de sellos no encontrada" });

            if ((card.rewards_earned || 0) <= 0) {
                return res.status(400).json({ error: "No tienes recompensas acumuladas pendientes para canjear en este negocio." });
            }

            const { data: updated, error: updErr } = await supabase.from('restaurant_loyalty_cards')
                .update({
                    rewards_earned: card.rewards_earned - 1,
                    rewards_redeemed: (card.rewards_redeemed || 0) + 1,
                    updated_at: new Date().toISOString()
                })
                .eq('id', card.id)
                .select()
                .single();

            if (updErr) throw updErr;

            return res.json({
                success: true,
                message: `¡Recompensa canjeada con éxito! Disfruta tu "${card.reward_description || 'Premio'}".`,
                card: updated
            });
        }

        if (action === 'partner_update_loyalty' && req.method === 'POST') {
            const { restaurantId, loyaltyEnabled, loyaltyStampGoal, loyaltyRewardText, whatsappOrdersPhone } = req.body || {};
            if (!restaurantId) return res.status(400).json({ error: "restaurantId is required" });

            const updates = {
                loyalty_enabled: loyaltyEnabled !== false,
                loyalty_stamp_goal: parseInt(loyaltyStampGoal) || 6,
                loyalty_reward_text: loyaltyRewardText || '1 Producto Gratis',
                whatsapp_orders_phone: whatsappOrdersPhone || null
            };

            const { data, error } = await supabase.from('restaurants')
                .update(updates)
                .eq('id', restaurantId)
                .select('id, name, loyalty_enabled, loyalty_stamp_goal, loyalty_reward_text, whatsapp_orders_phone')
                .maybeSingle();

            if (error) {
                // If column doesn't exist in restaurants table yet, store inside settings json
                const { data: resData } = await supabase.from('restaurants').select('settings').eq('id', restaurantId).single();
                const settings = resData?.settings || {};
                settings.loyalty = updates;
                await supabase.from('restaurants').update({ settings }).eq('id', restaurantId);
            }

            return res.json({ success: true, loyalty: updates });
        }

        // --- COMMISSION TOPUPS (RECEIPT UPLOADS) ---
        if (action === 'submit_commission_topup' && req.method === 'POST') {
            const { restaurantId, amount, receiptUrl, bankName, referenceNumber, notes } = req.body || {};
            const targetId = restaurantId || finalResId;
            if (!targetId) return res.status(400).json({ error: "restaurantId is required" });
            if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: "Monto válido es requerido" });
            if (!receiptUrl) return res.status(400).json({ error: "Foto / Comprobante de transferencia es requerido" });

            const payload = {
                restaurant_id: targetId,
                amount: parseFloat(amount),
                receipt_url: receiptUrl,
                bank_name: bankName || 'BAC Credomatic',
                reference_number: referenceNumber || null,
                notes: notes || null,
                status: 'pending'
            };

            const { data, error } = await supabase.from('commission_topups')
                .insert(payload)
                .select()
                .single();

            if (error) {
                console.error("Error submitting commission topup:", error);
                // Graceful fallback if table is not yet migrated
                return res.json({
                    success: true,
                    message: "Comprobante recibido. Será revisado y acreditado por administración.",
                    topup: { ...payload, id: 'temp-' + Date.now(), created_at: new Date().toISOString() }
                });
            }

            return res.json({
                success: true,
                message: "¡Comprobante enviado con éxito! Tu saldo será acreditado en breve tras la verificación.",
                topup: data
            });
        }

        if (action === 'get_partner_topups') {
            const targetId = req.query.restaurantId || finalResId;
            const { data, error } = await supabase.from('commission_topups')
                .select('*')
                .eq('restaurant_id', targetId)
                .order('created_at', { ascending: false })
                .limit(10);

            if (error) {
                return res.json({ success: true, topups: [] });
            }

            return res.json({ success: true, topups: data || [] });
        }

        // --- CUSTOMER ORDER HISTORY ---
        if (action === 'customer_orders') {
            const { phone, customerId } = req.query;
            const cleanPhone = phone ? phone.replace(/\D/g, '') : '';
            const phoneVariants = [];
            if (cleanPhone) {
                phoneVariants.push(cleanPhone);
                if (cleanPhone.length === 8) phoneVariants.push(`504${cleanPhone}`);
                if (cleanPhone.startsWith('504') && cleanPhone.length === 11) phoneVariants.push(cleanPhone.slice(3));
            }

            let customerIds = customerId ? [customerId] : [];
            if (phoneVariants.length > 0) {
                const { data: matchedCusts } = await supabase.from('customers')
                    .select('id')
                    .in('phone', phoneVariants);
                if (matchedCusts) {
                    customerIds = customerIds.concat(matchedCusts.map(c => c.id));
                }
            }

            let query = supabase.from('orders')
                .select('*')
                .order('created_at', { ascending: false })
                .limit(20);

            if (customerIds.length > 0) {
                query = query.in('customer_id', customerIds);
            } else {
                return res.json({ orders: [] });
            }

            const { data: orders, error } = await query;
            if (error) return res.status(500).json({ error: error.message });

            return res.json({ orders: orders || [] });
        }

        // --- PARTNER SELLS RICO CASH (OFFSETS PLATFORM FEES) ---
        if (action === 'partner_topup' && req.method === 'POST') {
            const { restaurant_id, phone, amount } = req.body || {};
            const targetId = restaurant_id || finalResId;
            const topupAmount = parseFloat(amount);

            if (!targetId) return res.status(400).json({ error: "restaurant_id is required" });
            if (!phone) return res.status(400).json({ error: "Teléfono del cliente es requerido" });
            if (!topupAmount || topupAmount <= 0) return res.status(400).json({ error: "Monto válido es requerido" });

            const cleanPhone = phone.replace(/\D/g, '');
            const phoneVariants = [cleanPhone];
            if (cleanPhone.length === 8) phoneVariants.push(`504${cleanPhone}`);
            if (cleanPhone.startsWith('504') && cleanPhone.length === 11) phoneVariants.push(cleanPhone.slice(3));

            // 1. Find or create customer
            let { data: customer } = await supabase.from('customers')
                .select('*')
                .in('phone', phoneVariants)
                .maybeSingle();

            if (!customer) {
                const newId = 'cust_' + Date.now() + Math.floor(Math.random()*1000);
                const { data: newCust, error: createErr } = await supabase.from('customers')
                    .insert({
                        id: newId,
                        phone: cleanPhone,
                        name: `Cliente ${cleanPhone.slice(-4)}`,
                        rico_balance: topupAmount,
                        points: 0
                    })
                    .select()
                    .single();
                if (createErr) throw createErr;
                customer = newCust;
            } else {
                const newBal = (parseFloat(customer.rico_balance) || 0) + topupAmount;
                const { data: updatedCust, error: updErr } = await supabase.from('customers')
                    .update({ rico_balance: newBal })
                    .eq('id', customer.id)
                    .select()
                    .single();
                if (updErr) throw updErr;
                customer = updatedCust;
            }

            // 2. Record in ledger: Merchant received physical cash, so it counts as fee settlement / cash collected
            await supabase.from('quimieats_ledger').insert({
                restaurant_id: targetId,
                amount: -topupAmount, // Deducts from merchant platform balance / offsets fees
                type: 'rico_cash_sold',
                status: 'settled',
                customer_id: customer.id,
                order_id: `Venta Rico Cash a ${cleanPhone} (Efectivo cobrado por negocio)`
            });

            // 3. Return updated info
            return res.json({
                success: true,
                customerName: customer.name || cleanPhone,
                amount: topupAmount,
                newBalance: parseFloat(customer.rico_balance) || 0,
                message: `¡Recarga de L. ${topupAmount.toFixed(2)} acreditada con éxito al cliente!`
            });
        }

        // --- 5. MENU ---
        if (action === 'menu') {
            const [rItems, rModGroups, rModOptions, rItemModGroups, restaurant] = await Promise.all([
                supabase.from('menu_items').select('*').eq('restaurant_id', finalResId).order('name'),
                supabase.from('modifier_groups').select('*').eq('restaurant_id', finalResId).order('name'),
                supabase.from('modifier_options').select('*').order('name'),
                supabase.from('item_modifier_groups').select('*'),
                supabase.from('restaurants').select('settings').eq('id', finalResId).maybeSingle()
            ]);
            let items = rItems.data || [];
            const settings = restaurant?.data?.settings || {};
            const productInventory = settings.product_inventory || {};
            const activeBatches = settings.batches || [];
            const gachaPromoItemIds = settings.gachaPromoItemIds || [];
            
            items = items.map(item => ({
                ...item,
                is_gacha_promo: gachaPromoItemIds.includes(item.id)
            }));
            
            // Apply Chameleon Shift menu filters (America/Tegucigalpa timezone)
            const localTimeStr = new Date().toLocaleString("en-US", { timeZone: "America/Tegucigalpa" });
            const localDate = new Date(localTimeStr);
            const localHour = localDate.getHours();

            const nightOnlyIds = ['food_captain_rico_smash', 'food_double_social_smash', 'food_jungle_melt', 'food_griddled_skins'];
            const morningOnlyIds = ['food_fitness_baleada', 'food_fit_burger', 'food_protein_bowl'];

            if (localHour >= 6 && localHour < 14) {
                // Morning Shift: Hide Night-only smash burgers
                items = items.filter(i => !nightOnlyIds.includes(i.id));
            } else if (localHour >= 16 && localHour < 22) {
                // Night Shift: Hide Morning-only baleadas/fit-bowls
                items = items.filter(i => !morningOnlyIds.includes(i.id));
            } else if (localHour >= 14 && localHour < 16) {
                // Mid-day Rest: Show night menu for preview
                items = items.filter(i => !morningOnlyIds.includes(i.id));
            }

            const isAdmin = req.query.admin === 'true';
            const now = new Date();

            const filteredItems = items.filter(i => isAdmin || i.available !== false).map(item => {
                let p = (parseFloat(item.price) || 0);
                let finalPrice = p;
                let originalPrice = p;
                let promoTag = null;
                
                const itemConfig = productInventory[item.id] || { is_unlimited: true };
                let stockQuantity = itemConfig.stock_quantity;
                let expiresInHours = undefined;
                let isUnlimited = itemConfig.is_unlimited !== false;

                if (!isUnlimited) {
                    const itemBatches = activeBatches.filter(b => b.menu_item_id === item.id);
                    const validBatches = itemBatches.filter(b => new Date(b.expires_at) > now && b.quantity > 0);
                    stockQuantity = validBatches.reduce((sum, b) => sum + b.quantity, 0);

                    if (validBatches.length > 0) {
                        const sorted = [...validBatches].sort((a,b) => new Date(a.expires_at) - new Date(b.expires_at));
                        const closest = sorted[0];
                        expiresInHours = (new Date(closest.expires_at) - now) / (1000 * 60 * 60);

                        if (expiresInHours <= 12) {
                            finalPrice = p * 0.50; // 50% OFF
                            promoTag = "50% OFF Próximo a vencer";
                        } else if (expiresInHours <= 24) {
                            finalPrice = p * 0.80; // 20% OFF
                            promoTag = "20% OFF Lote del día";
                        }
                    } else {
                        stockQuantity = 0;
                    }
                }

                return { 
                    ...item, 
                    price: finalPrice, 
                    original_price: originalPrice, 
                    promo_tag: promoTag, 
                    stock_quantity: stockQuantity,
                    is_unlimited: isUnlimited,
                    default_daily_stock: itemConfig.default_daily_stock || null,
                    expires_in_hours: expiresInHours
                };
            });

            // Gather items expiring in under 12 hours with active stock to push as Gacha rewards
            const expiringPrizes = filteredItems.filter(i => !i.is_unlimited && i.expires_in_hours !== undefined && i.expires_in_hours <= 12 && i.stock_quantity > 0).map(i => ({
                id: i.id,
                name: i.name,
                category: i.category
            }));

            const grouped = {};
            filteredItems.forEach(item => {
                const cat = (item.category || 'otros').toLowerCase();
                if (!grouped[cat]) grouped[cat] = [];
                grouped[cat].push({ 
                    id: item.id, 
                    name: item.name, 
                    price: item.price, 
                    original_price: item.original_price,
                    promo_tag: item.promo_tag,
                    available: item.is_unlimited ? item.available : (item.stock_quantity > 0), 
                    stock_quantity: item.stock_quantity,
                    is_unlimited: item.is_unlimited,
                    expires_in_hours: item.expires_in_hours,
                    image_url: item.image_url 
                });
            });
            const categories = Object.keys(grouped).map(c => ({ id: c, name: c.charAt(0).toUpperCase() + c.slice(1), items: grouped[c] }));
            const groups = rModGroups.data || [];
            const groupIds = groups.map(g => g.id);
            const options = (rModOptions.data || []).filter(o => groupIds.includes(o.group_id));
            const itemIds = filteredItems.map(i => i.id);
            const mappings = (rItemModGroups.data || []).filter(m => itemIds.includes(m.item_id) && groupIds.includes(m.group_id));

            return res.json({ 
                items: filteredItems, 
                categories, 
                expiringPrizes, 
                modGroups: groups, 
                modOptions: options, 
                itemModGroups: mappings, 
                acceptedPayments: settings.accepted_payments || {}, 
                taxRate: 0 
            });
        }

        // --- 6. PARTNER DASHBOARD ---
        if (action === 'partner_register') {
            const { name, owner, phone, category } = req.body || {};
            if (!name || !phone) return res.status(400).json({ error: "Nombre y teléfono son obligatorios" });

            // Generate clean unique restaurant ID slug
            let baseSlug = name.toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .replace(/[^a-z0-9]/g, '-')
                .replace(/-+/g, '-')
                .replace(/^-|-$/g, '');
                
            if (!baseSlug) baseSlug = 'negocio';
            const suffix = Math.floor(1000 + Math.random() * 9000);
            const generatedResId = `${baseSlug}-${suffix}`;
            
            // Generate random 4-digit PIN
            const generatedPin = String(Math.floor(1000 + Math.random() * 9000));
            
            const trialEnd = new Date();
            trialEnd.setDate(trialEnd.getDate() + 7);

            const { data, error } = await supabase.from('restaurants').insert({
                id: generatedResId,
                name: name,
                contact_phone: phone.replace(/\D/g, ''),
                status: 'active',
                settings: {
                    pin: generatedPin,
                    owner: owner || 'Propietario',
                    category: category || 'general',
                    plan: 'elite_trial',
                    trial_end: trialEnd.toISOString(),
                    is_taking_orders: true
                }
            }).select().single();

            if (error) {
                return res.status(500).json({ error: error.message });
            }

            // Automatically seed L. 500 Launch Commission Credit in QuimiEats Ledger
            await supabase.from('quimieats_ledger').insert({
                restaurant_id: generatedResId,
                amount: 500.00,
                type: 'welcome_promo_credit',
                status: 'settled',
                customer_id: 'system_promo',
                order_id: 'promo_welcome_500'
            }).catch(err => console.error("[Partner Registration] Failed to seed welcome credit:", err));

            // Send WhatsApp credentials notification to the registered merchant
            const cleanPhone = phone.replace(/\D/g, '');
            let phoneToMsg = cleanPhone;
            if (cleanPhone.length === 8) phoneToMsg = `504${cleanPhone}`;
            
            const welcomeText = `¡Hola! Tu negocio *${name}* ha sido registrado con éxito en QuimiEats 🚀.\n\n🔑 Tu PIN maestro para entrar al sistema es: *${generatedPin}*\n\nUsa este PIN para iniciar sesión en: https://quimieats.com/os\n\n¡Liderando la nueva era comercial de Quimistán! 🐒`;
            
            sendWhatsAppNotification(phoneToMsg, welcomeText).catch(err => {
                console.error("[Partner Registration] Failed to send credentials WhatsApp notification:", err);
            });

            return res.json({ success: true, resId: generatedResId, pin: generatedPin });
        }

        if (action === 'partner_update_plan') {
            const { restaurant_id, plan, in_person_onboarding } = req.body || {};
            if (!restaurant_id || !plan) return res.status(400).json({ error: "Missing parameters" });

            // Fetch current settings
            const { data: resData, error: fetchErr } = await supabase.from('restaurants').select('settings').eq('id', restaurant_id).single();
            if (fetchErr) return res.status(500).json({ error: fetchErr.message });

            const settings = resData?.settings || {};
            settings.plan = plan;
            settings.in_person_onboarding = !!in_person_onboarding;
            if (plan === 'basic') {
                settings.trial_end = null;
            } else {
                const trialEnd = new Date();
                trialEnd.setDate(trialEnd.getDate() + 7);
                settings.trial_end = trialEnd.toISOString();
            }

            const { error: updateErr } = await supabase.from('restaurants').update({ settings }).eq('id', restaurant_id);
            if (updateErr) return res.status(500).json({ error: updateErr.message });

            return res.json({ success: true, plan, in_person_onboarding: settings.in_person_onboarding });
        }

        if (action === 'restaurant_info') {
            const targetResId = id || req.query.id;
            if (!targetResId) return res.status(400).json({ error: "Missing id parameter" });
            const { data, error } = await supabase.from('restaurants').select('id, name, logo_url, settings, category').eq('id', targetResId).maybeSingle();
            if (error || !data) return res.status(404).json({ error: "Restaurant not found" });
            return res.json(data);
        }

        if (action === 'partner_login') {
            const { restaurantId, pin } = req.body || {};
            if (!restaurantId || !pin) return res.status(400).json({ error: "Missing parameters" });

            const targetResId = restaurantId.toLowerCase().replace(/[^a-z0-9-]/g, '');
            const { data: resData, error } = await supabase.from('restaurants').select('*').eq('id', targetResId).maybeSingle();
            
            if (error || !resData) {
                return res.status(401).json({ error: "Restaurante no encontrado" });
            }

            const expectedPin = resData.settings?.pin || '4574';
            if (pin !== expectedPin) {
                return res.status(401).json({ error: "PIN incorrecto" });
            }

            return res.json({ success: true, partner: { id: resData.id, name: resData.name, phone: resData.contact_phone, settings: resData.settings || {} } });
        }

        if (action === 'partner_update_settings') {
            const { restaurantId, acceptedPayments, bankDetails, gachaCampaign, operatingHours, bookingLeadTime, bookingBuffer } = req.body || {};
            if (!restaurantId) return res.status(400).json({ error: "restaurantId is required" });

            const { data: resData } = await supabase.from('restaurants').select('settings').eq('id', restaurantId).single();
            const settings = resData?.settings || {};
            settings.accepted_payments = acceptedPayments || {};
            settings.bank_details = bankDetails || {};
            if (operatingHours) {
                settings.operating_hours = operatingHours;
            }
            if (req.body.ugc_codes) {
                settings.ugc_codes = req.body.ugc_codes;
            }
            if (bookingLeadTime !== undefined) {
                settings.booking_lead_time = bookingLeadTime;
            }
            if (bookingBuffer !== undefined) {
                settings.booking_buffer = bookingBuffer;
            }

            if (gachaCampaign) {
                // Enforce Thursday lock rule (locks on Friday day=5)
                const localTimeStr = new Date().toLocaleString("en-US", { timeZone: "America/Tegucigalpa" });
                const localDate = new Date(localTimeStr);
                const currentDay = localDate.getDay();
                if (currentDay === 5) {
                    return res.status(400).json({ error: "No puedes modificar tu campaña de Gacha los días viernes de ruleta activa." });
                }

                const currentCampaign = settings.gachaCampaign || {};
                const qty = parseInt(gachaCampaign.quantity) || 5;

                settings.gachaCampaign = {
                    isActive: !!gachaCampaign.isActive,
                    itemId: gachaCampaign.itemId || '',
                    quantity: qty,
                    remainingStock: currentCampaign.remainingStock !== undefined ? currentCampaign.remainingStock : qty,
                    automateWeekly: !!gachaCampaign.automateWeekly,
                    lastResetWeek: currentCampaign.lastResetWeek || ''
                };
            }

            const { data, error } = await supabase.from('restaurants')
                .update({ settings })
                .eq('id', restaurantId)
                .select()
                .single();

            if (error) throw error;
            return res.json({ success: true, settings: data.settings });
        }

        if (action === 'partner_orders') {
            const resId = req.query.restaurantId;
            if (!resId) return res.status(400).json({ error: "restaurantId is required" });

            const { data, error } = await supabase.from('orders')
                .select('*, customers(name, phone)')
                .eq('restaurant_id', resId)
                .order('created_at', { ascending: false })
                .limit(50);

            if (error) throw error;
            return res.json({ orders: data || [] });
        }

        if (action === 'partner_update_order') {
            const { orderId, status } = req.body || {};
            if (!orderId || !status) return res.status(400).json({ error: "Missing parameters" });

            const { data, error } = await supabase.from('orders')
                .update({ status })
                .eq('id', orderId)
                .select()
                .single();

            if (error) throw error;
            return res.json({ success: true, order: data });
        }

        if (action === 'partner_update_item') {
            const { itemId, price, available, is_unlimited, default_daily_stock, stock_quantity, is_gacha_promo } = req.body || {};
            if (!itemId) return res.status(400).json({ error: "itemId is required" });

            const updates = {};
            if (price !== undefined) updates.price = parseFloat(price);
            if (available !== undefined) updates.available = !!available;

            let itemData = null;
            if (Object.keys(updates).length > 0) {
                const { data, error } = await supabase.from('menu_items')
                    .update(updates)
                    .eq('id', itemId)
                    .select()
                    .single();
                if (error) throw error;
                itemData = data;
            } else {
                const { data, error } = await supabase.from('menu_items')
                    .select('*')
                    .eq('id', itemId)
                    .single();
                if (error) throw error;
                itemData = data;
            }

            if (itemData) {
                const resId = itemData.restaurant_id;
                const { data: resData } = await supabase.from('restaurants').select('settings').eq('id', resId).single();
                const settings = resData?.settings || {};
                settings.product_inventory = settings.product_inventory || {};
                
                settings.product_inventory[itemId] = settings.product_inventory[itemId] || {};
                if (is_unlimited !== undefined) settings.product_inventory[itemId].is_unlimited = !!is_unlimited;
                if (default_daily_stock !== undefined) {
                    settings.product_inventory[itemId].default_daily_stock = default_daily_stock === '' ? null : parseInt(default_daily_stock);
                }
                if (stock_quantity !== undefined) {
                    settings.product_inventory[itemId].stock_quantity = stock_quantity === '' ? null : parseInt(stock_quantity);
                }
                if (req.body.duration !== undefined) {
                    settings.product_inventory[itemId].duration = req.body.duration === '' ? null : parseInt(req.body.duration);
                }

                // Gacha promo handling
                if (is_gacha_promo !== undefined) {
                    settings.gachaPromoItemIds = settings.gachaPromoItemIds || [];
                    if (is_gacha_promo) {
                        if (!settings.gachaPromoItemIds.includes(itemId)) {
                            settings.gachaPromoItemIds.push(itemId);
                        }
                    } else {
                        settings.gachaPromoItemIds = settings.gachaPromoItemIds.filter(id => id !== itemId);
                    }
                }

                await supabase.from('restaurants').update({ settings }).eq('id', resId);
                
                // Add tag dynamically to return payload
                itemData.is_gacha_promo = (settings.gachaPromoItemIds || []).includes(itemId);
            }

            return res.json({ success: true, item: itemData });
        }

        if (action === 'partner_ai_describe') {
            const { imageBase64 } = req.body || {};
            if (!imageBase64) return res.status(400).json({ error: "imageBase64 is required" });
            const result = await describeMenuItemPhoto(imageBase64);
            return res.json(result);
        }

        if (action === 'partner_create_item' || action === 'partner_save_item') {
            try {
                const { restaurant_id, name, price, category, is_unlimited, default_daily_stock, imageBase64, is_gacha_promo } = req.body || {};
                if (!restaurant_id || !name || !price) return res.status(400).json({ error: "Faltan campos obligatorios (nombre, precio o restaurante)" });

                // Ensure restaurant exists in DB
                let { data: resData } = await supabase.from('restaurants').select('id, settings').eq('id', restaurant_id).maybeSingle();
                if (!resData) {
                    const { data: newRes, error: insertResErr } = await supabase.from('restaurants').insert({
                        id: restaurant_id,
                        name: restaurant_id.replace(/-/g, ' ').toUpperCase(),
                        status: 'active',
                        settings: { is_taking_orders: true }
                    }).select().single();
                    if (insertResErr) {
                        console.error("[partner_save_item] Auto-restaurant create warning:", insertResErr);
                    }
                    resData = newRes || { settings: {} };
                }

                let imageUrl = null;
                if (imageBase64) {
                    try {
                        const rawBase64 = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
                        const buffer = Buffer.from(rawBase64, 'base64');
                        const filePath = `uploads/${Date.now()}_item.jpg`;
                        const { error: uploadErr } = await supabase.storage.from('menu-images').upload(filePath, buffer, { contentType: 'image/jpeg', upsert: true });
                        if (!uploadErr) {
                            imageUrl = supabase.storage.from('menu-images').getPublicUrl(filePath).data.publicUrl;
                        } else {
                            console.warn("[partner_save_item] Storage upload warning:", uploadErr);
                        }
                    } catch(e) { console.error("[partner_save_item] Image parse failed:", e); }
                }

                const itemId = `${restaurant_id}-${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${Math.floor(100 + Math.random() * 900)}`;

                const { data: itemData, error } = await supabase.from('menu_items').insert({
                    id: itemId,
                    restaurant_id,
                    name,
                    price: parseFloat(price),
                    category: category || 'comida',
                    image_url: imageUrl,
                    available: true
                }).select().single();

                if (error) {
                    console.error("[partner_save_item] menu_items insert error:", error);
                    return res.status(500).json({ error: "Error al registrar plato: " + error.message });
                }

                // Save JSONB config to settings
                const settings = resData?.settings || {};
                settings.product_inventory = settings.product_inventory || {};
                settings.product_inventory[itemId] = {
                    is_unlimited: is_unlimited !== false,
                    default_daily_stock: default_daily_stock ? parseInt(default_daily_stock) : null,
                    stock_quantity: is_unlimited !== false ? null : 0,
                    duration: req.body.duration ? parseInt(req.body.duration) : null
                };

                if (is_gacha_promo) {
                    settings.gachaPromoItemIds = settings.gachaPromoItemIds || [];
                    settings.gachaPromoItemIds.push(itemId);
                }

                await supabase.from('restaurants').update({ settings }).eq('id', restaurant_id);

                if (itemData) {
                    itemData.is_gacha_promo = !!is_gacha_promo;
                }

                return res.json({ success: true, item: itemData });
            } catch (err) {
                console.error("[partner_save_item] Catch-all error:", err);
                return res.status(500).json({ error: "Error interno del servidor: " + (err.message || "Error desconocido") });
            }
        }

        if (action === 'partner_delete_item') {
            const { itemId } = req.body || {};
            if (!itemId) return res.status(400).json({ error: "itemId is required" });

            const { data: itemData } = await supabase.from('menu_items').select('restaurant_id').eq('id', itemId).single();

            const { error } = await supabase.from('menu_items').delete().eq('id', itemId);
            if (error) throw error;

            if (itemData) {
                const resId = itemData.restaurant_id;
                const { data: resData } = await supabase.from('restaurants').select('settings').eq('id', resId).single();
                const settings = resData?.settings || {};
                if (settings.product_inventory) {
                    delete settings.product_inventory[itemId];
                }
                if (settings.batches) {
                    settings.batches = settings.batches.filter(b => b.menu_item_id !== itemId);
                }
                await supabase.from('restaurants').update({ settings }).eq('id', resId);
            }

            return res.json({ success: true });
        }

        if (action === 'partner_add_batch') {
            const { itemId, batchName, quantity, hoursToExpire } = req.body || {};
            if (!itemId || !batchName || quantity === undefined || !hoursToExpire) {
                return res.status(400).json({ error: "Missing required batch parameters" });
            }

            const { data: itemData } = await supabase.from('menu_items').select('restaurant_id').eq('id', itemId).single();
            if (!itemData) return res.status(404).json({ error: "Item not found" });
            const resId = itemData.restaurant_id;

            const expiresAt = new Date(Date.now() + parseInt(hoursToExpire) * 60 * 60 * 1000).toISOString();

            const { data: resData } = await supabase.from('restaurants').select('settings').eq('id', resId).single();
            const settings = resData?.settings || {};
            settings.batches = settings.batches || [];
            settings.product_inventory = settings.product_inventory || {};

            const newBatch = {
                id: 'batch_' + Date.now() + '_' + Math.floor(Math.random() * 100),
                menu_item_id: itemId,
                batch_name: batchName,
                quantity: parseInt(quantity),
                expires_at: expiresAt,
                created_at: new Date().toISOString()
            };

            settings.batches.push(newBatch);

            // Update item stock quantity
            settings.product_inventory[itemId] = settings.product_inventory[itemId] || {};
            const currentStock = settings.product_inventory[itemId].stock_quantity || 0;
            settings.product_inventory[itemId].stock_quantity = currentStock + parseInt(quantity);
            settings.product_inventory[itemId].is_unlimited = false;

            await supabase.from('restaurants').update({ settings }).eq('id', resId);

            // Set item available in menu_items table
            await supabase.from('menu_items').update({ available: true }).eq('id', itemId);

            return res.json({ success: true, batch: newBatch });
        }

        if (action === 'partner_generate_ugc_codes') {
            const { restaurantId, rewardType, rewardValue, count, maxClaims } = req.body || {};
            if (!restaurantId || !rewardType || !rewardValue || !count) {
                return res.status(400).json({ error: "Missing required parameters" });
            }

            const { data: rest, error } = await supabase.from('restaurants').select('*').eq('id', restaurantId).maybeSingle();
            if (error || !rest) return res.status(404).json({ error: "Restaurant not found" });

            const settings = rest.settings || {};
            if (!settings.ugc_codes) settings.ugc_codes = {};

            const limit = parseInt(maxClaims) || 1;
            const codes = [];
            for (let i = 0; i < count; i++) {
                const code = `${restaurantId}_UGC_${Math.floor(100000 + Math.random() * 900000)}`;
                settings.ugc_codes[code] = {
                    reward_type: rewardType,
                    reward_value: rewardValue,
                    max_claims: limit,
                    is_redeemed: false,
                    claims: []
                };
                codes.push(code);
            }

            await supabase.from('restaurants').update({ settings }).eq('id', restaurantId);
            return res.json({ success: true, codes });
        }

        if (action === 'get_ugc_code_info') {
            const { code } = req.query;
            if (!code) return res.status(400).json({ error: "Code is required" });

            const parts = code.split('_UGC_');
            if (parts.length < 2) return res.status(400).json({ error: "Invalid claim code format" });
            const restaurantId = parts[0];

            const { data: rest } = await supabase.from('restaurants').select('*').eq('id', restaurantId).maybeSingle();
            if (!rest) return res.status(404).json({ error: "Restaurant not found" });

            const settings = rest.settings || {};
            if (!settings.ugc_codes || !settings.ugc_codes[code]) {
                return res.status(404).json({ error: "Código de regalo inválido o no existe." });
            }

            const claimData = settings.ugc_codes[code];
            const maxClaims = parseInt(claimData.max_claims) || 1;
            const currentClaimsCount = (claimData.claims || []).length;

            let itemName = null;
            if (claimData.reward_type === 'item') {
                const { data: item } = await supabase.from('menu_items').select('name').eq('id', claimData.reward_value).maybeSingle();
                if (item) itemName = item.name;
            }

            return res.json({
                success: true,
                reward_type: claimData.reward_type,
                reward_value: claimData.reward_value,
                reward_item_name: itemName,
                max_claims: maxClaims,
                claims_count: currentClaimsCount,
                is_fully_redeemed: claimData.is_redeemed || currentClaimsCount >= maxClaims,
                restaurant_name: rest.name
            });
        }

        if (action === 'claim_ugc_code') {
            const { code, customerId } = req.body || {};
            if (!code || !customerId) return res.status(400).json({ error: "Code and Customer ID are required" });

            const parts = code.split('_UGC_');
            if (parts.length < 2) return res.status(400).json({ error: "Invalid claim code format" });
            const restaurantId = parts[0];

            const { data: rest } = await supabase.from('restaurants').select('*').eq('id', restaurantId).maybeSingle();
            if (!rest) return res.status(404).json({ error: "Restaurant not found" });

            const settings = rest.settings || {};
            if (!settings.ugc_codes || !settings.ugc_codes[code]) {
                return res.status(404).json({ error: "Código de regalo inválido o no existe." });
            }

            const claimData = settings.ugc_codes[code];
            const maxClaims = parseInt(claimData.max_claims) || 1;
            if (!claimData.claims) claimData.claims = [];

            // 1. Check if limit is reached
            if (claimData.is_redeemed || claimData.claims.length >= maxClaims) {
                return res.status(400).json({ error: "Este código de regalo ya alcanzó su límite de ganadores." });
            }

            // 2. Check if customer has already claimed it
            if (claimData.claims.some(c => c.customer_id === customerId)) {
                return res.status(400).json({ error: "Ya has reclamado esta recompensa." });
            }

            // Fetch customer to award points
            const { data: cust } = await supabase.from('customers').select('*').eq('id', customerId).maybeSingle();
            if (!cust) return res.status(404).json({ error: "Cliente no encontrado." });

            if (claimData.reward_type === 'points' || claimData.reward_type === 'gacha_spin') {
                const ptsToAdd = parseInt(claimData.reward_value) || 0;
                const newPoints = (cust.points || 0) + ptsToAdd;
                
                // Tier logic check
                let newTier = cust.tier || 'bronze';
                if (newPoints >= 1500) newTier = 'gold';
                else if (newPoints >= 500) newTier = 'silver';
                
                await supabase.from('customers').update({ 
                    points: newPoints,
                    tier: newTier
                }).eq('id', customerId);
            }

            if (claimData.reward_type === 'item') {
                // Verify menu item exists
                const { data: item } = await supabase.from('menu_items').select('id, name').eq('id', claimData.reward_value).maybeSingle();
                if (!item) return res.status(404).json({ error: "El producto de regalo ya no existe." });

                // Push new voucher entry into restaurant's gachaClaims array
                if (!settings.gachaClaims) settings.gachaClaims = [];
                settings.gachaClaims.push({
                    claimCode: `QL-UGC-${Math.floor(1000 + Math.random() * 9000)}-${Math.floor(1000 + Math.random() * 9000)}`,
                    customerId: customerId,
                    itemId: claimData.reward_value,
                    isRedeemed: false,
                    createdAt: new Date().toISOString()
                });
            }

            // Append claim record
            claimData.claims.push({
                customer_id: customerId,
                claimed_at: new Date().toISOString()
            });

            // Mark as redeemed if full
            if (claimData.claims.length >= maxClaims) {
                claimData.is_redeemed = true;
            }

            await supabase.from('restaurants').update({ settings }).eq('id', restaurantId);

            return res.json({
                success: true,
                reward_type: claimData.reward_type,
                reward_value: claimData.reward_value,
                restaurant_name: rest.name
            });
        }

        if (action === 'list_drivers') {
            const { data, error } = await supabase.from('employees').select('id, name').eq('role', 'driver').eq('active', true).order('name');
            if (error) throw error;
            return res.json({ success: true, drivers: data || [] });
        }

        if (action === 'assign_driver' && req.method === 'POST') {
            const { orderId, driverId } = req.body || {};
            if (!orderId || !driverId) return res.status(400).json({ error: "orderId and driverId are required" });

            const { data: driver } = await supabase.from('employees').select('name').eq('id', driverId).maybeSingle();
            if (!driver) return res.status(404).json({ error: "Driver not found" });

            const { data: order } = await supabase.from('orders').select('notes').eq('id', orderId).single();
            const cleanNotes = (order.notes || '').replace(/\[DRIVER:[^\]]+\]/g, '').trim();
            const updatedNotes = (cleanNotes + ` [DRIVER: id=${driverId}, status=assigned]`).trim();

            const { data, error } = await supabase.from('orders')
                .update({ 
                    driver_id: driverId, 
                    delivery_status: 'assigned',
                    notes: updatedNotes
                })
                .eq('id', orderId)
                .select()
                .single();

            if (error) throw error;
            return res.json({ success: true, order: data });
        }

        // --- DRIVER FLOWS ---
        if (action === 'driver_login' && req.method === 'POST') {
            const { pin } = req.body;
            const { data: driver, error } = await supabase
                .from('employees')
                .select('*')
                .eq('pin', pin)
                .eq('role', 'driver')
                .eq('active', true)
                .maybeSingle();

            if (error || !driver) return res.status(401).json({ success: false, error: "PIN invalido" });
            return res.json({ success: true, driver });
        }

        if (action === 'driver_signup' && req.method === 'POST') {
            const { name, phone, vehicle } = req.body;
            const cleanPhone = phone.replace(/\D/g, '');
            const driverId = 'drv_' + Date.now() + Math.floor(Math.random()*1000);
            const tempPin = Math.floor(Math.random() * 9000 + 1000).toString();

            const { data, error } = await supabase.from('employees').insert({
                id: driverId,
                name: name,
                role: 'driver',
                pin: tempPin,
                active: true,
                color: 'cyan',
                hourly_rate: 0
            }).select().single();

            if (error) throw error;
            return res.json({ success: true, pin: tempPin, driverId: data.id });
        }

        if (action === 'driver_orders' && req.method === 'GET') {
            const { driverId, mode } = req.query;
            try {
                let query = supabase.from('orders')
                    .select('*, customers(name, phone)')
                    .eq('status', 'ready');

                if (mode === 'available') {
                    query = query.is('driver_id', null);
                } else {
                    query = query.eq('driver_id', driverId).not('delivery_status', 'eq', 'delivered');
                }

                const { data, error } = await query.order('created_at', { ascending: false });
                if (error) throw error;
                return res.json({ orders: data || [] });
            } catch (e) {
                // Fallback: search within notes field metadata
                const { data, error } = await supabase.from('orders')
                    .select('*, customers(name, phone)')
                    .order('created_at', { ascending: false });
                
                if (error) throw error;
                const filtered = (data || []).filter(o => {
                    const hasDriver = o.notes?.includes('[DRIVER:');
                    if (mode === 'available') {
                        return !hasDriver && (o.status === 'ready' || o.status === 'preparing');
                    } else {
                        return o.notes?.includes(`[DRIVER: id=${driverId}`) && !o.notes?.includes('status=delivered');
                    }
                });
                return res.json({ orders: filtered });
            }
        }

        if (action === 'driver_claim' && req.method === 'POST') {
            const { id } = req.query;
            const { driverId } = req.body;

            try {
                const { data: existing } = await supabase.from('orders').select('driver_id').eq('id', id).single();
                if (existing && existing.driver_id) return res.status(409).json({ error: "Ya reclamado" });

                const { data, error } = await supabase.from('orders')
                    .update({ 
                        driver_id: driverId, 
                        delivery_status: 'assigned' 
                    })
                    .eq('id', id)
                    .select()
                    .single();

                if (error) throw error;
                return res.json({ success: true, order: data });
            } catch (e) {
                const { data: order } = await supabase.from('orders').select('*').eq('id', id).maybeSingle();
                if (!order) return res.status(404).json({ error: "Orden no encontrada" });
                if (order.notes?.includes('[DRIVER:')) return res.status(409).json({ error: "Ya reclamado" });

                const updatedNotes = (order.notes || '') + ` [DRIVER: id=${driverId}, status=assigned]`;
                const { data: updated, error } = await supabase.from('orders')
                    .update({ notes: updatedNotes })
                    .eq('id', id)
                    .select()
                    .single();
                
                if (error) throw error;
                return res.json({ 
                    success: true, 
                    order: { 
                        ...updated, 
                        driver_id: driverId, 
                        delivery_status: 'assigned' 
                    } 
                });
            }
        }

        if (action === 'order_delivery_status' && req.method === 'PATCH') {
            const { id } = req.query;
            const { status, driverId, pin } = req.body;

            // PIN Verification Check for Courier Deliveries
            if (status === 'delivered') {
                const { data: order, error: orderErr } = await supabase.from('orders').select('*').eq('id', id).maybeSingle();
                if (order) {
                    let expectedPin = order.delivery_pin;
                    if (!expectedPin && order.notes) {
                        const match = order.notes.match(/\[DELIVERY_PIN:\s*(\d{4})\]/);
                        if (match) expectedPin = match[1];
                    }
                    if (expectedPin && expectedPin.trim() !== (pin || '').trim()) {
                        return res.status(400).json({ error: "Código de entrega PIN incorrecto" });
                    }
                }
            }

            try {
                const { data, error } = await supabase.from('orders')
                    .update({ 
                        delivery_status: status,
                        status: status === 'delivered' ? 'completed' : 'ready'
                    })
                    .eq('id', id)
                    .eq('driver_id', driverId)
                    .select()
                    .single();

                if (error) throw error;
                return res.json({ success: true, order: data });
            } catch (e) {
                const { data: order } = await supabase.from('orders').select('*').eq('id', id).maybeSingle();
                if (!order) return res.status(404).json({ error: "Orden no encontrada" });

                const cleanNotes = (order.notes || '').replace(/\[DRIVER:[^\]]+\]/g, '').trim();
                const updatedNotes = (cleanNotes + ` [DRIVER: id=${driverId}, status=${status}]`).trim();
                
                const { data: updated, error } = await supabase.from('orders')
                    .update({ 
                        status: status === 'delivered' ? 'completed' : order.status,
                        notes: updatedNotes 
                    })
                    .eq('id', id)
                    .select()
                    .single();

                if (error) throw error;
                return res.json({ 
                    success: true, 
                    order: { 
                        ...updated, 
                        driver_id: driverId, 
                        delivery_status: status 
                    } 
                });
            }
        }

        // --- DYNAMIC CASHOUT OTP (DRIVER & RESTAURANT INSTANT CASH-OUT) ---
        if (action === 'driver_generate_cashout_otp' && req.method === 'POST') {
            const { driverId, amount } = req.body || {};
            if (!driverId) return res.status(400).json({ error: "driverId is required" });

            const otp = Math.floor(1000 + Math.random() * 9000).toString(); // 4-digit random OTP
            const otpNumeric = parseFloat(otp);

            let { data: driver, error } = await supabase.from('employees')
                .update({
                    hourly_rate: otpNumeric, // store temporary OTP safely
                    updated_at: new Date().toISOString()
                })
                .eq('id', driverId)
                .select('id, name')
                .maybeSingle();

            if (!driver) {
                // Fallback: update any active driver
                const { data: fallbackDrv } = await supabase.from('employees')
                    .update({ hourly_rate: otpNumeric })
                    .eq('role', 'driver')
                    .select('id, name')
                    .limit(1);
                if (fallbackDrv && fallbackDrv.length > 0) driver = fallbackDrv[0];
            }

            if (!driver) return res.status(404).json({ error: "Driver no encontrado" });

            return res.json({
                success: true,
                otp,
                expiresInMinutes: 15,
                message: `Tu código de retiro seguro es ${otp}. Muéstralo al cajero del restaurante para recibir tu efectivo.`
            });
        }

        if (action === 'partner_payout_driver_with_otp' && req.method === 'POST') {
            const { restaurantId, driverOtp, amount } = req.body || {};
            const payoutAmount = parseFloat(amount);

            if (!restaurantId) return res.status(400).json({ error: "restaurantId is required" });
            if (!driverOtp || driverOtp.toString().length !== 4) return res.status(400).json({ error: "Código PIN de 4 dígitos inválido" });
            if (!payoutAmount || payoutAmount <= 0) return res.status(400).json({ error: "Monto inválido" });

            // 1. Find driver by active OTP
            const { data: drivers, error: drvErr } = await supabase.from('employees')
                .select('*')
                .eq('hourly_rate', parseFloat(driverOtp))
                .eq('role', 'driver')
                .limit(1);

            const driver = drivers && drivers.length > 0 ? drivers[0] : null;

            if (drvErr || !driver) {
                return res.status(400).json({ error: "Código PIN incorrecto o expirado. Pide al motorista generar un nuevo código en su portal." });
            }

            // 2. Invalidate OTP immediately to prevent reuse
            await supabase.from('employees')
                .update({ hourly_rate: 0 })
                .eq('id', driver.id);

            // 3. Credit Restaurant Ledger (They gave cash out of register, so QuimiEats credits their balance)
            await supabase.from('quimieats_ledger').insert({
                restaurant_id: restaurantId,
                amount: payoutAmount, // Credits restaurant balance
                type: 'driver_payout_advance',
                status: 'settled',
                customer_id: driver.id,
                order_id: `Pago en efectivo a motorista ${driver.name} (Retiro Nocturno PIN ${driverOtp})`
            });

            return res.json({
                success: true,
                driverName: driver.name,
                amount: payoutAmount,
                message: `✅ ¡Retiro validado con éxito! Entrega L. ${payoutAmount.toFixed(2)} en efectivo a ${driver.name}. El monto fue acreditado a tu saldo QuimiEats.`
            });
        }

        if (action === 'customer_confirm_delivery' && req.method === 'POST') {
            const { id } = req.query;
            try {
                const { data, error } = await supabase.from('orders')
                    .update({ 
                        delivery_status: 'delivered',
                        status: 'completed'
                    })
                    .eq('id', id)
                    .select()
                    .single();

                if (error) throw error;
                return res.json({ success: true, order: data });
            } catch (e) {
                const { data: order } = await supabase.from('orders').select('*').eq('id', id).single();
                const cleanNotes = (order.notes || '').replace(/\[DRIVER:[^\]]+\]/g, '').trim();
                const updatedNotes = (cleanNotes + ` [DRIVER: status=delivered]`).trim();

                const { data: updated, error } = await supabase.from('orders')
                    .update({ 
                        status: 'completed',
                        notes: updatedNotes 
                    })
                    .eq('id', id)
                    .select()
                    .single();

                if (error) throw error;
                return res.json({ 
                    success: true, 
                    order: { 
                        ...updated, 
                        delivery_status: 'delivered' 
                    } 
                });
            }
        }

        return res.status(404).json({ error: `Action '${action}' not found`, debug: { url: req.url, action, id } });

    } catch (e) {
        console.error("Store API Error:", e);
        return res.status(500).json({ error: e.message });
    }
};

async function sendWhatsAppNotification(toPhone, text) {
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;

    if (!accessToken || !phoneId) {
        console.warn("[Partner Notification] Missing WhatsApp environment variables. Mocking send:");
        console.log(`[Mock WhatsApp Send] To: ${toPhone}, Content: "${text}"`);
        return;
    }

    const fetch = require('node-fetch');
    const url = `https://graph.facebook.com/v18.0/${phoneId}/messages`;
    
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                messaging_product: "whatsapp",
                recipient_type: "individual",
                to: toPhone,
                type: "text",
                text: { body: text }
            })
        });

        if (!res.ok) {
            const errBody = await res.text();
            console.error("[Partner Notification] Failed to send WhatsApp message:", errBody);
        } else {
            console.log(`[Partner Notification] Credentials message sent successfully to ${toPhone}`);
        }
    } catch (e) {
        console.error("[Partner Notification] Error sending WhatsApp request:", e);
    }
}
