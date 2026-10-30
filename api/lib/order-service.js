const { supabase: defaultSupabase } = require('./supabase');
const { awardPoints, syncMembershipState, getHondurasDate } = require('./loyalty');
const ricoLoyalty = require('./rico-loyalty');
const { unlockMissionsForOrder } = require('./mission-unlock');
const { applyVipBenefits, applyBootcampBenefits, calculateSurgeDiscounts } = require('./pricing');
const { deductInventoryForOrder } = require('./inventory-service');
const { notifyOrder } = require('./email-service');
const { isMasterPin, isAdminToken } = require('./auth');

// ---------------------------------------------------------------------------
// SEC-FIX 2 (audit F4 + F3): server-side pricing + wallet-PIN verification.
//
// Prices are NEVER taken from the client again. The unit price of every item
// is recomputed here from menu_items, exactly the way handler-v2-menu
// displays it (batch-expiry discount first, then the rich-aroma transform
// round(price * 1.15 / 5) * 5), plus the price_adjustment of each modifier
// option matched from modifier_options (clients send mods as {name} only,
// so options are matched by id when present, else by name, within the
// groups linked to the item via item_modifier_groups).
//
// A Rico Cash debit additionally requires proof: the customer's own PIN in
// the request body (customerPin) OR a verified staff/master Bearer
// credential (the POS checkout sends its staff PIN as Bearer).
// ---------------------------------------------------------------------------

function round2(n) {
    return parseFloat((parseFloat(n) || 0).toFixed(2));
}

/** Selling price of a menu_items row, mirroring handler-v2-menu exactly. */
function displayPriceFor(menuRow, settings, restaurantId) {
    let p = parseFloat(menuRow.price) || 0;
    let finalPrice = p;
    const productInventory = (settings && settings.product_inventory) || {};
    const batches = (settings && settings.batches) || [];
    const cfg = productInventory[menuRow.id] || { is_unlimited: true };
    if (cfg.is_unlimited === false) {
        const now = new Date();
        const valid = batches.filter(b => b.menu_item_id === menuRow.id && new Date(b.expires_at) > now && (parseFloat(b.quantity) || 0) > 0);
        if (valid.length > 0) {
            const sorted = [...valid].sort((a, b) => new Date(a.expires_at) - new Date(b.expires_at));
            const expiresInHours = (new Date(sorted[0].expires_at) - now) / (1000 * 60 * 60);
            if (expiresInHours <= 12) finalPrice = p * 0.50;
            else if (expiresInHours <= 24) finalPrice = p * 0.80;
        }
    }
    if (restaurantId === 'rich-aroma') {
        finalPrice = Math.round((finalPrice * 1.15) / 5) * 5;
    }
    return finalPrice;
}

/**
 * Verify a Bearer credential the same way store.js verify-pin does:
 * env master PIN / admin token, an active employee's PIN, or the
 * restaurant settings PIN. Returns true only for a verified staff caller.
 */
async function verifyStaffBearer(bearer, supabase, restaurantId) {
    const token = String(bearer || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return false;
    if (isMasterPin(token) || isAdminToken(token)) return true;
    try {
        const { data: emp } = await supabase.from('employees').select('id').eq('pin', token).eq('active', true).maybeSingle();
        if (emp) return true;
    } catch (e) { /* fall through to settings PIN */ }
    try {
        const { data: resList } = await supabase.from('restaurants').select('id').contains('settings', { pin: token });
        if (resList && resList.length > 0) return true;
    } catch (e) { /* not a staff credential */ }
    return false;
}

function ricoPinRequiredError() {
    const err = new Error('RICO_PIN_REQUIRED: Se requiere el PIN del cliente o autorización del personal para pagar con Rico Cash');
    err.status = 401;
    err.code = 'RICO_PIN_REQUIRED';
    return err;
}

/**
 * Promo-code ceiling: a code may discount ONLY house-made items.
 * Returns the maximum discount the server will honor for the code's percent.
 * The POS rounds each item's net price to the nearest L.5, so the ceiling
 * includes that rounding slack per eligible unit.
 */
function promoEligibleCap(items, percent) {
    let subtotal = 0;
    let units = 0;
    (items || []).forEach(i => {
        if (i && i.is_house_made === true) {
            subtotal += (parseFloat(i.price) || 0) * (i.qty || 1);
            units += (i.qty || 1);
        }
    });
    const raw = subtotal * ((parseFloat(percent) || 0) / 100);
    return {
        cap: parseFloat((raw + (units * 2.5) + 0.01).toFixed(2)),
        eligibleSubtotal: parseFloat(subtotal.toFixed(2)),
        eligibleUnits: units
    };
}

/**
 * Main Order Orchestrator for Rich Aroma OS & QuimiEats
 */
async function createOrder(orderRequest, supabase = defaultSupabase, authContext = {}) {
    const items = orderRequest.items;
    const paymentMethod = orderRequest.paymentMethod || orderRequest.payment_method;
    const secondaryPaymentMethod = orderRequest.secondaryPaymentMethod || orderRequest.secondary_payment_method;
    const ricoAmount = orderRequest.ricoAmount || orderRequest.rico_amount;
    const customerPin = orderRequest.customerPin ?? orderRequest.customer_pin ?? null;
    const customerId = orderRequest.customerId || orderRequest.customer_id;
    const customerPhone = orderRequest.customerPhone || orderRequest.customer_phone;
    const customerName = orderRequest.customerName || orderRequest.customer_name;
    const notes = orderRequest.notes;
    const fulfillment = orderRequest.fulfillment || orderRequest.fulfillment_type;
    const restaurantId = orderRequest.restaurantId || orderRequest.restaurant_id;
    const isPos = orderRequest.isPos || orderRequest.is_pos || false;
    const shiftId = orderRequest.shiftId || orderRequest.shift_id;
    const guestPhone = orderRequest.guestPhone || orderRequest.guest_phone;
    const scheduledFor = orderRequest.scheduledFor || orderRequest.scheduled_for;
    // Prep time (WhatsApp bot "¿Para cuándo?", 2026-10-26): the slot
    // the customer asked the shop to prepare for — an ISO 8601 string
    // carrying the shop's UTC offset, plus its display label
    // ("12:30 PM"). Absent/null = ASAP. Deliberately NOT stored in
    // scheduled_for: that column belongs to the storefront/QuimiEats
    // scheduling flow, with its own semantics — reusing it would let
    // two features write each other's field.
    const requestedFor = orderRequest.requestedFor || orderRequest.requested_for || null;
    const requestedForLabel = orderRequest.requestedForLabel || orderRequest.requested_for_label || null;
    const category = orderRequest.category;
    let promoCode = (orderRequest.promoCode || orderRequest.promo_code || '').toString().trim().toUpperCase() || null;
    if (!promoCode && notes) {
        const metaMatch = String(notes).match(/\[DISC_META:(\{[^\]]*\})\]/);
        if (metaMatch) { try { const meta = JSON.parse(metaMatch[1]); if (meta.c) promoCode = String(meta.c).trim().toUpperCase(); } catch (e) {} }
    }

    const targetResId = restaurantId || 'rich-aroma';
    const cleanPhone = (customerPhone || guestPhone || '').replace(/\D/g, '');

    try {
        // --- 0. MULTI-TENANT SAFEGUARD ---
        const { data: checkRes } = await supabase.from('restaurants').select('id').eq('id', targetResId).maybeSingle();
        if (!checkRes) {
            console.log(`[OrderService] Auto-creating missing restaurant: ${targetResId}`);
            const { error: insErr } = await supabase.from('restaurants').insert({
                id: targetResId,
                name: targetResId.replace(/-/g, ' ').toUpperCase(),
                status: 'active',
                category: category || 'restaurante', // Use the new category
                settings: { auto_created: true }
            });
            if (insErr) console.error(`[OrderService] Failed to create restaurant: ${insErr.message}`);
        } else if (category && !checkRes.category) {
            // Update category if it was missing
            await supabase.from('restaurants').update({ category }).eq('id', targetResId);
        }

        // 1. Identify/Sync Customer
        let customer = null;
        let finalCustomerId = customerId;

        if (!finalCustomerId && cleanPhone) {
            const { data: existing } = await supabase.from('customers').select('id').eq('phone', cleanPhone).maybeSingle();
            if (existing) {
                finalCustomerId = existing.id;
            } else {
                // Auto-create guest
                const { data: newCust } = await supabase.from('customers').insert({
                    id: 'cust_' + Date.now(),
                    phone: cleanPhone,
                    name: customerName || 'Invitado',
                    points: 0
                }).select().single();
                if (newCust) finalCustomerId = newCust.id;
            }
        }

        if (finalCustomerId) {
            const { data } = await supabase.from('customers').select('*').eq('id', finalCustomerId).single();
            if (data) {
                customer = await syncMembershipState(data, supabase);
            }
        }

        // 2. Pricing & Meta Logic — SEC-FIX 2 (audit F4): SERVER PRICES ONLY.
        // Client-supplied item prices, subtotal and total are ignored. Unit
        // prices are recomputed from menu_items (displayPriceFor mirrors
        // handler-v2-menu) + matched modifier option price_adjustments.
        // Items whose id is NOT on the menu (e.g. the WhatsApp bot's wa-*
        // ids) keep their client price so bot orders keep working, but they
        // can never be charged to Rico Cash (see section 3).
        let _staffAuthPromise = null;
        const staffAuthorized = () => {
            if (!_staffAuthPromise) _staffAuthPromise = verifyStaffBearer(authContext && authContext.bearer, supabase, targetResId);
            return _staffAuthPromise;
        };

        const itemIds = [...new Set((items || []).map(i => i.id).filter(Boolean))];
        const [menuRes, resSettingsRes] = await Promise.all([
            supabase.from('menu_items').select('id, name, price, category, is_house_made, is_vip_free_eligible').in('id', itemIds),
            supabase.from('restaurants').select('settings').eq('id', targetResId).maybeSingle()
        ]);
        const menuItems = menuRes.data || [];
        const menuById = {};
        menuItems.forEach(m => { if (!(m.id in menuById)) menuById[m.id] = m; });
        const restaurantSettings = (resSettingsRes && resSettingsRes.data && resSettingsRes.data.settings) || {};

        // Modifier options for the groups linked to the ordered items
        const optionsByItem = {};
        if (itemIds.length > 0) {
            const { data: links } = await supabase.from('item_modifier_groups').select('item_id, group_id').in('item_id', itemIds);
            const groupIds = [...new Set((links || []).map(l => l.group_id).filter(Boolean))];
            if (groupIds.length > 0) {
                const { data: opts } = await supabase.from('modifier_options').select('id, group_id, name, price_adjustment').in('group_id', groupIds);
                const optsByGroup = {};
                (opts || []).forEach(o => { (optsByGroup[o.group_id] = optsByGroup[o.group_id] || []).push(o); });
                (links || []).forEach(l => { (optionsByItem[l.item_id] = optionsByItem[l.item_id] || []).push(...(optsByGroup[l.group_id] || [])); });
            }
        }
        // MOD-STANDARD: countable options (e.g. Splenda sobres) carry a
        // qty in the client snapshot; price the option once per unit.
        const modQty = (mod) => { const q = parseInt(mod && mod.qty); return Number.isInteger(q) && q > 0 ? Math.min(q, 8) : 1; };
        const matchOption = (itemId, mod) => {
            const pool = optionsByItem[itemId] || [];
            if (!pool.length || mod === null || mod === undefined) return null;
            const modId = (typeof mod === 'object') ? (mod.id || mod.option_id || mod.optionId) : null;
            if (modId) {
                const byId = pool.find(o => o.id === modId);
                if (byId) return byId;
            }
            const modName = String(typeof mod === 'object' ? (mod.name || '') : mod).trim().toLowerCase();
            if (!modName) return null;
            return pool.find(o => String(o.name || '').trim().toLowerCase() === modName) || null;
        };

        let serverSubtotal = 0;
        let hasUnpricedItem = false;
        const itemsWithMeta = (items || []).map(item => {
            const meta = menuById[item.id];
            const qty = parseInt(item.qty) || 1;
            if (!meta) {
                hasUnpricedItem = true;
                const fallbackPrice = parseFloat(item.price) || 0;
                serverSubtotal += fallbackPrice * qty;
                return {
                    ...item,
                    qty,
                    price: fallbackPrice,
                    finalPrice: round2(fallbackPrice * qty),
                    category: item.category || 'General',
                    is_house_made: item.is_house_made || false,
                    is_vip_free_eligible: false,
                    server_priced: false
                };
            }
            let unit = displayPriceFor(meta, restaurantSettings, targetResId);
            const mods = Array.isArray(item.mods) ? item.mods : (Array.isArray(item.modifiers) ? item.modifiers : []);
            mods.forEach(mod => {
                const opt = matchOption(item.id, mod);
                if (opt) unit += (parseFloat(opt.price_adjustment) || 0) * modQty(mod);
            });
            unit = round2(unit);
            serverSubtotal += unit * qty;
            return {
                ...item,
                qty,
                price: unit,
                finalPrice: round2(unit * qty),
                category: meta?.category || 'General',
                is_house_made: meta?.is_house_made || false,
                is_vip_free_eligible: meta?.is_vip_free_eligible || false,
                server_priced: true
            };
        });
        serverSubtotal = round2(serverSubtotal);

        // Surge Engine (Rich Aroma Only for now)
        let surgeDiscount = 0;
        if (targetResId === 'rich-aroma') {
            const { data: activeSurges } = await supabase.from('surge_deals')
                .select('*')
                .eq('active', true)
                .gt('expires_at', new Date().toISOString());
            surgeDiscount = calculateSurgeDiscounts(itemsWithMeta, activeSurges || []);
        }

        // VIP Engine — totals come from the SERVER numbers computed above;
        // orderRequest.subtotal / orderRequest.total are never trusted.
        let finalOrderData = {
            items: itemsWithMeta,
            subtotal: serverSubtotal,
            total: round2(serverSubtotal - surgeDiscount),
            discount: surgeDiscount,
            tier: 'Basic'
        };

        // Manual discount claim (POS courtesy discount, or the POS's
        // promo pre-computation). Honored only when a promo code is present
        // (section 2.5 clamps it to the house-made ceiling) or when the
        // request carries a verified staff/master credential. Otherwise the
        // claim is ignored — an anonymous client cannot discount itself.
        const claimedDiscount = parseFloat(orderRequest.discount) || 0;
        if (claimedDiscount > (parseFloat(finalOrderData.discount) || 0) && (promoCode || await staffAuthorized())) {
            finalOrderData.discount = claimedDiscount;
            // No floor here on purpose: the promo block below restores
            // total/discount consistency by adding back any excess over the
            // ceiling. The total is floored at 0 after section 2.5.
            finalOrderData.total = round2(serverSubtotal - claimedDiscount);
        }

        let freeDrinkClaimed = false;
        if (customer && !orderRequest.discount) { // Only auto-apply VIP if NO manual discount from POS
            const tags = Array.isArray(customer.tags) ? customer.tags : [];
            const isVip = customer.is_vip || tags.includes('VIP') || tags.includes('BlackCard') || tags.includes('Diamond') || tags.includes('GoldCard') || tags.includes('Familia') || tags.includes('Employee');
            
            if (isVip) {
                // --- TIME LOCK CHECK (Anti-Sharing) ---
                // Prevent multiple status orders within 20 mins to prevent sharing
                const twentyMinsAgo = new Date(Date.now() - 20 * 60000).toISOString();
                const { data: recentOrders } = await supabase
                    .from('orders')
                    .select('id')
                    .eq('customer_id', customer.id)
                    .gte('created_at', twentyMinsAgo)
                    .limit(1);

                if (recentOrders && recentOrders.length > 0 && !isPos) {
                    throw new Error('STATUS_COOLDOWN: Debes esperar 20 minutos entre pedidos con descuento de membresía.');
                }

                const vipCalc = applyVipBenefits(itemsWithMeta, customer);
                finalOrderData.items = vipCalc.items;
                // SEC-FIX 2: the VIP total is always the server's computation
                // (client totals are ignored); vipCalc runs on server prices.
                finalOrderData.total = vipCalc.total - surgeDiscount;
                finalOrderData.discount += vipCalc.items.reduce((sum, i) => sum + (i.appliedDiscount || 0), 0);
                finalOrderData.tier = vipCalc.tier;
                
                if (vipCalc.freeDrinkClaimed) {
                    await supabase.from('customers').update({ last_free_drink_date: getHondurasDate() }).eq('id', customer.id);
                }
            } else if (tags.includes('Bootcamp')) {
                const bootCalc = applyBootcampBenefits(itemsWithMeta, customer);
                finalOrderData.items = bootCalc.items;
                // SEC-FIX 2: server computation always wins (see VIP above).
                finalOrderData.total = bootCalc.total - surgeDiscount;
                finalOrderData.discount += bootCalc.items.reduce((sum, i) => sum + (i.appliedDiscount || 0), 0);
                finalOrderData.tier = 'Bootcamp';
            }
        }

        // 2.5 Promo Code Verification (house-made items only; the register's discount is never trusted past the ceiling)
        let promoRow = null;
        let promoApplied = false;
        let promoNote = '';
        if (promoCode) {
            const { data: row } = await supabase.from('promo_codes').select('*').eq('code', promoCode).maybeSingle();
            const usable = row && row.active !== false && (!row.expires_at || new Date(row.expires_at).getTime() > Date.now()) && (row.max_uses == null || (row.uses || 0) < row.max_uses);
            if (usable) {
                promoRow = row;
                const { cap } = promoEligibleCap(finalOrderData.items, row.percent);
                if ((parseFloat(finalOrderData.discount) || 0) > cap) {
                    const excess = parseFloat((finalOrderData.discount - cap).toFixed(2));
                    finalOrderData.discount = cap;
                    finalOrderData.total = parseFloat(((parseFloat(finalOrderData.total) || 0) + excess).toFixed(2));
                }
                promoApplied = (parseFloat(finalOrderData.discount) || 0) > 0;
                if (promoApplied) promoNote = `[PROMO: ${row.code} -${row.percent}% CASA]`;
            } else {
                if ((parseFloat(finalOrderData.discount) || 0) > 0) {
                    finalOrderData.total = parseFloat(((parseFloat(finalOrderData.total) || 0) + (parseFloat(finalOrderData.discount) || 0)).toFixed(2));
                    finalOrderData.discount = 0;
                }
                promoNote = `[PROMO REJECTED: ${promoCode}]`;
            }
        }

        // 2.6 LOYALTY (2026-10-30): deals-engine type 2 (Compra X, llevá Y)
        // and the Creadores BOGO door adjust the price HERE — server-side,
        // before any wallet math. Deals NEVER stack with a promo code:
        // when a promo discount was actually granted above, both skip.
        let bogoApplied = false;
        let dealDiscountApplied = 0;
        if (!promoApplied) {
            const bg = await ricoLoyalty.buyGetDiscount(supabase, { restaurantId: targetResId, items: finalOrderData.items });
            if (bg.discount > 0) {
                finalOrderData.discount = round2((parseFloat(finalOrderData.discount) || 0) + bg.discount);
                finalOrderData.total = round2(finalOrderData.total - bg.discount);
                promoNote = (promoNote + ` [OFERTA: ${bg.campaign.name}]`).trim();
                dealDiscountApplied += bg.discount;
            }
            if (customer) {
                const bo = await ricoLoyalty.bogoDiscount(supabase, { customerId: customer.id, items: finalOrderData.items, restaurantId: targetResId });
                if (bo.discount > 0) {
                    finalOrderData.discount = round2((parseFloat(finalOrderData.discount) || 0) + bo.discount);
                    finalOrderData.total = round2(finalOrderData.total - bo.discount);
                    promoNote = (promoNote + ' [BOGO CREADORES]').trim();
                    bogoApplied = true;
                    dealDiscountApplied += bo.discount;
                }
            }
        }
        // 2.7 ESPECIAL DEL DÍA + RACHA (2026-10-30): price-side effects of
        // a special the customer claimed today, and the Racha streak
        // discount. Neither stacks with a promo code or a price deal —
        // the Especial wins over the Racha (it was claimed on purpose).
        // The streak WEEK still counts at paid time either way; only the
        // discount is suppressed when another deal touched the order.
        if (!promoApplied && customer) {
            if (dealDiscountApplied <= 0) {
                const ed = await ricoLoyalty.especialDiscountForOrder(supabase, {
                    customer, items: finalOrderData.items, restaurantId: targetResId
                });
                if (ed.discount > 0) {
                    finalOrderData.discount = round2((parseFloat(finalOrderData.discount) || 0) + ed.discount);
                    finalOrderData.total = round2(finalOrderData.total - ed.discount);
                    promoNote = (promoNote + ' [ESPECIAL DEL DÍA]').trim();
                    dealDiscountApplied += ed.discount;
                }
            }
            if (dealDiscountApplied <= 0) {
                const sd = await ricoLoyalty.streakDiscountForOrder(supabase, {
                    customer, items: finalOrderData.items,
                    discount: parseFloat(finalOrderData.discount) || 0,
                    restaurantId: targetResId
                });
                if (sd.discount > 0) {
                    finalOrderData.discount = round2((parseFloat(finalOrderData.discount) || 0) + sd.discount);
                    finalOrderData.total = round2(finalOrderData.total - sd.discount);
                    promoNote = (promoNote + ` [RACHA: ${sd.pct}%]`).trim();
                }
            }
        }
        if ((parseFloat(finalOrderData.discount) || 0) > serverSubtotal) finalOrderData.discount = serverSubtotal;

        // SEC-FIX 2: with totals computed server-side, a discount can never
        // push an order below zero.
        finalOrderData.total = Math.max(0, round2(finalOrderData.total));

        // 3. Rico Balance Logic — SEC-FIX 2 (audit F3): a wallet debit
        // requires proof. Either the debited customer's own PIN arrives in
        // the body (customerPin — storefront flow) or the request carries a
        // verified staff/master Bearer credential (POS flow — the cashier
        // collects the customer's PIN at the till). Neither → 401 and the
        // order is NOT created with a Rico tender. Items that could not be
        // server-priced can never be charged to a wallet.
        const ricoInvolved = paymentMethod === 'rico_balance' || paymentMethod === 'rico_cash' ||
            secondaryPaymentMethod === 'rico_balance' || secondaryPaymentMethod === 'rico_cash' ||
            (parseFloat(ricoAmount) || 0) > 0;
        if (ricoInvolved) {
            const pinOk = !!(customer && customerPin !== null && customerPin !== undefined && String(customerPin).trim() !== '' &&
                customer.pin !== null && customer.pin !== undefined && String(customer.pin).trim() !== '' &&
                String(customerPin).trim() === String(customer.pin).trim());
            if (!pinOk && !(await staffAuthorized())) {
                throw ricoPinRequiredError();
            }
            if (hasUnpricedItem) {
                const unpricedErr = new Error('RICO_UNPRICED_ITEM: No se puede cobrar con Rico Cash un artículo que no está en el menú');
                unpricedErr.status = 400;
                unpricedErr.code = 'RICO_UNPRICED_ITEM';
                throw unpricedErr;
            }
        }

        let orderStatus = 'pending';
        let ricoAmountPaid = 0;
        let ricoBonusUsed = 0;
        // Order identity is minted HERE (it used to be section 4) because
        // the wallet ledger rows below carry the order id.
        const orderNum = Math.floor(Date.now() / 1000) - 1769000000;
        const orderId = 'ORD-' + Date.now() + '-' + Math.floor(Math.random() * 1000);

        // LOYALTY (2026-10-30): the two-bucket spend replaces the one-pot
        // debit. Gift money ("Regalo de la casa") draws FIRST, capped at
        // the order's house-made net portion — server-enforced in
        // rico-loyalty.settleWalletForOrder — then the customer's own
        // money ("Tu dinero", the legacy rico_balance). Runs whenever
        // Rico is involved: as the primary tender it keeps the legacy
        // status semantics (full → 'paid', partial → 'partial_paid',
        // empty wallet → throw), as a secondary tender it debits without
        // touching the status.
        const ricoPrimary = paymentMethod === 'rico_balance' || paymentMethod === 'rico_cash';
        const ricoSecondary = secondaryPaymentMethod === 'rico_balance' || secondaryPaymentMethod === 'rico_cash';
        if ((ricoPrimary || ricoSecondary || (parseFloat(ricoAmount) || 0) > 0) && customer) {
            const totalWallet = (parseFloat(customer.rico_balance) || 0)
                + await ricoLoyalty.getBonusBalance(supabase, customer.id);
            if (ricoPrimary && totalWallet <= 0) throw new Error('Saldo insuficiente en Rico Cash');
            const walletTarget = (parseFloat(ricoAmount) || 0) > 0 ? parseFloat(ricoAmount) : finalOrderData.total;
            const settled = await ricoLoyalty.settleWalletForOrder(supabase, {
                id: orderId,
                order_number: orderNum,
                customer_id: customer.id,
                total: finalOrderData.total,
                discount: finalOrderData.discount,
                items: finalOrderData.items
            }, { walletTarget });
            ricoBonusUsed = settled.bonusUsed;
            ricoAmountPaid = round2(settled.bonusUsed + settled.paidUsed);
            finalOrderData.items = settled.items;
            if (ricoPrimary) {
                if (ricoAmountPaid >= finalOrderData.total) orderStatus = 'paid';
                else if (ricoAmountPaid > 0) orderStatus = 'partial_paid';
            }
        }

        // 4. Create Order

        const dbOrder = {
            id: orderId,
            order_number: orderNum,
            items: finalOrderData.items,
            subtotal: finalOrderData.subtotal,
            total: finalOrderData.total,
            discount: finalOrderData.discount,
            tax: 0,
            status: orderStatus,
            payment_method: paymentMethod,
            secondary_payment_method: secondaryPaymentMethod,
            rico_amount_paid: ricoAmountPaid || ricoAmount || 0,
            rico_bonus_used: ricoBonusUsed,
            customer_id: finalCustomerId,
            restaurant_id: targetResId,
            shift_id: shiftId,
            scheduled_for: scheduledFor,
            notes: (finalOrderData.tier !== 'Basic' ? `[STATUS: ${finalOrderData.tier.toUpperCase()}] [SALUDO: ${(customer?.name || '').split(' ')[0].toUpperCase()}] ` : '') + 
                   `[FULFILLMENT: ${fulfillment || 'pickup'}] ` + 
                   (guestPhone ? `[TEL: ${guestPhone}] ` : '') + 
                   (notes || '')
        };

        // Prep time: the columns are written ONLY when the payload
        // carries a chosen slot, so a request without the field
        // produces the exact order row it did before this feature.
        if (requestedFor) {
            dbOrder.requested_for = requestedFor;
            dbOrder.requested_for_label = requestedForLabel;
        }

        if (promoNote) dbOrder.notes = (dbOrder.notes || '') + ' ' + promoNote;

        if (fulfillment === 'delivery') {
            const deliveryPin = Math.floor(1000 + Math.random() * 9000).toString();
            dbOrder.delivery_pin = deliveryPin;
            dbOrder.notes = (dbOrder.notes || '') + ` [DELIVERY_PIN: ${deliveryPin}]`;
        }

        // Gift / Diaspora Meta Note
        if (orderRequest.isGift || orderRequest.is_gift) {
            const gFrom = orderRequest.customerName || orderRequest.senderName || 'Alguien especial';
            const gTo = orderRequest.recipientName || orderRequest.recipient_name || 'Familiar';
            const gNote = orderRequest.giftNote || orderRequest.gift_note || '';
            const gTel = orderRequest.recipientPhone || orderRequest.recipient_phone || '';
            dbOrder.notes = (dbOrder.notes || '') + ` [🎁 REGALO: De ${gFrom} para ${gTo} | Mensaje: "${gNote}" | Tel: ${gTel}]`;
        }

        // QuimiEats Commission Note
        if (!isPos && targetResId !== 'rich-aroma') {
            const commission = parseFloat(dbOrder.total) * 0.08;
            const ledgerNote = `[LEDGER: type=commission, amount=-${commission.toFixed(2)}, status=settled]`;
            dbOrder.notes = (dbOrder.notes || '') + " " + ledgerNote;
        }

        // Bank Transfer Screenshot Upload & Gemini AI Verification Audit
        if (paymentMethod === 'transfer' && !isPos) {
            dbOrder.status = 'awaiting_transfer_approval';
            
            if (orderRequest.transferScreenshot) {
                try {
                    const base64Data = orderRequest.transferScreenshot.replace(/^data:image\/\w+;base64,/, "");
                    const buffer = Buffer.from(base64Data, 'base64');
                    const fileName = `comprobantes/${Date.now()}-${Math.floor(Math.random() * 100000)}.png`;
                    
                    const { data: uploadData, error: uploadErr } = await supabase.storage
                        .from('menu-images')
                        .upload(fileName, buffer, { contentType: 'image/png', upsert: true });
                        
                    if (uploadErr) throw uploadErr;
                    
                    const publicUrl = supabase.storage.from('menu-images').getPublicUrl(fileName).data.publicUrl;
                    
                    // Call AI Auditor
                    const { auditTransferScreenshot } = require('./ai-service');
                    const aiReport = await auditTransferScreenshot(orderRequest.transferScreenshot, dbOrder.total, orderRequest.transferReference);
                    
                    dbOrder.notes = (dbOrder.notes || '') + ` [TRANSFER_REF: ${orderRequest.transferReference || aiReport.reference_number || 'PENDIENTE'}] [TRANSFER_IMAGE: ${publicUrl}] [AI_STATUS: ${aiReport.status}] [AI_REPORT: ${JSON.stringify(aiReport)}]`;
                } catch (err) {
                    console.error("[OrderService] Screenshot upload / AI audit failed:", err);
                    dbOrder.notes = (dbOrder.notes || '') + ` [TRANSFER_REF: ${orderRequest.transferReference || 'PENDIENTE'}] [AI_STATUS: suspicious] [AI_REPORT: {"status":"suspicious","reason":"Fallo en carga de imagen o auditoría AI"}]`;
                }
            } else {
                dbOrder.notes = (dbOrder.notes || '') + ` [TRANSFER_REF: ${orderRequest.transferReference || 'PENDIENTE'}] [AI_STATUS: pending]`;
            }
        }

        let data = null;
        let error = null;
        try {
            const firstTry = await supabase.from('orders').insert(dbOrder).select().single();
            data = firstTry.data;
            error = firstTry.error;

            if (error) {
                const errorMsg = error.message || '';
                console.warn("[OrderService] First insert try error:", errorMsg);
                const fallbackOrder = { ...dbOrder };
                
                if (errorMsg.includes('delivery_pin') || errorMsg.includes('delivery_status') || errorMsg.includes('driver_id')) {
                    delete fallbackOrder.delivery_pin;
                    delete fallbackOrder.delivery_status;
                    delete fallbackOrder.driver_id;
                }
                if (errorMsg.includes('requested_for')) {
                    // The prep-time migration has not run on this DB
                    // yet — degrade loudly, never lose the order over
                    // a display field: retry without the two columns.
                    console.warn('[OrderService] requested_for columns missing (run the prep-time migration) — retrying without them');
                    delete fallbackOrder.requested_for;
                    delete fallbackOrder.requested_for_label;
                }
                if (errorMsg.includes('rico_bonus_used')) {
                    // The loyalty migration has not run on this DB yet —
                    // degrade loudly, never lose the order over the new
                    // column (the in-memory split below still feeds the
                    // earn/mission readers).
                    console.warn('[OrderService] rico_bonus_used column missing (run the loyalty migration) — retrying without it');
                    delete fallbackOrder.rico_bonus_used;
                }
                if (errorMsg.includes('orders_restaurant_id_fkey')) {
                    fallbackOrder.notes = (fallbackOrder.notes || '') + ` [ORIGINAL_RESTAURANT: ${targetResId}]`;
                    fallbackOrder.restaurant_id = 'rich-aroma';
                }
                
                const retry = await supabase.from('orders').insert(fallbackOrder).select().single();
                data = retry.data;
                error = retry.error;
            }
        } catch (dbErr) {
            console.warn("[OrderService] Supabase connection error:", dbErr.message);
            error = dbErr;
        }

        if (error || !data) {
            // SEC-FIX 6 (audit F14): a persistence failure must surface as
            // an error — NEVER fabricate a success. This block previously
            // wrote the order to data/orders.json and returned an in-memory
            // copy as if it had been saved: the POS showed the sale as
            // completed while the order existed nowhere in the database
            // (the Oct 24 phantom orders), and promo counting, loyalty
            // points, stamps, inventory deduction and the notification
            // email still ran on the phantom. Now the failure throws, so
            // handler-orders-v2 answers 5xx and the POS can retry through
            // its offline queue instead of believing a lost sale.
            console.error("[OrderService] Order Creation Failed:", error);
            if (error) throw error;
            const noDataErr = new Error('ORDER_PERSIST_FAILED: la orden no devolvió datos al guardarse');
            noDataErr.status = 500;
            noDataErr.code = 'ORDER_PERSIST_FAILED';
            throw noDataErr;
        }

        // LOYALTY: the locally computed split is authoritative even when
        // the rico_bonus_used column is not in the DB yet (the fallback
        // above) — the earn/mission readers below consume this object.
        data.rico_bonus_used = ricoBonusUsed;
        if (bogoApplied && customer) await ricoLoyalty.markBogoRedeemed(supabase, customer.id);

        // 4.4 Promo code use counting (only when a discount was actually granted)
        if (promoRow && promoApplied) {
            const { error: promoErr } = await supabase.from('promo_codes').update({ uses: (promoRow.uses || 0) + 1 }).eq('id', promoRow.id);
            if (promoErr) console.error('[OrderService] Promo use increment failed:', promoErr.message);
        }

        // 4.5 Record automated QuimiEats commission and perform credit limit check
        if (!isPos && targetResId !== 'rich-aroma') {
            (async () => {
                try {
                    const commissionAmt = parseFloat(dbOrder.total) * 0.08;
                    
                    // A. Insert into ledger (commission debit)
                    await supabase.from('quimieats_ledger').insert({
                        restaurant_id: targetResId,
                        amount: -commissionAmt,
                        type: 'commission',
                        status: 'settled',
                        customer_id: finalCustomerId || 'client',
                        order_id: data.id
                    });

                    // B. Credit order total to merchant if paid via platform-held channels (rico_balance, transfer, card, stripe)
                    const isPlatformHeld = ['rico_balance', 'rico_cash', 'transfer', 'card', 'stripe'].includes(paymentMethod);
                    if (isPlatformHeld) {
                        await supabase.from('quimieats_ledger').insert({
                            restaurant_id: targetResId,
                            amount: parseFloat(dbOrder.total),
                            type: 'order_credit',
                            status: 'settled',
                            customer_id: finalCustomerId || 'client',
                            order_id: data.id
                        });
                    }

                    // B. Query new balance to see if they exceed limit
                    const { data: ledgerRows } = await supabase.from('quimieats_ledger').select('amount').eq('restaurant_id', targetResId);
                    const bal = (ledgerRows || []).reduce((sum, l) => sum + parseFloat(l.amount), 0);

                    // C. Auto-suspend restaurant if balance < -100
                    if (bal < -100) {
                        await supabase.from('restaurants').update({ status: 'suspended' }).eq('id', targetResId);
                    }
                } catch (e) {
                    console.error("[OrderService] Automated commission deduction error:", e);
                }
            })();
        }

        // 5. Post-Order Background Tasks
        (async () => {
            // LOYALTY (2026-10-30): an order BORN paid in this engine
            // earns its gift + drops campaign gifts, and unlocks its
            // missions — the one-line unlock the missions build waited
            // for (orders created already-paid never passed through the
            // store.js status paths). Both helpers are failure-silent
            // and idempotent; orders that turn paid LATER are covered
            // by the store.js order_update hook instead.
            if (data.status === 'paid' && finalCustomerId) {
                await ricoLoyalty.processPaidOrder(supabase, data);
                await unlockMissionsForOrder(data, supabase);
            }
            // Loyalty Points
            if (finalCustomerId) {
                await awardPoints(finalCustomerId, dbOrder.total, paymentMethod, supabase);
            }
            // Digital Stamp Card Logic (Rich Aroma Coffee/Bebidas category)
            if (finalCustomerId && targetResId === 'rich-aroma') {
                try {
                    const coffeeItemsCount = (dbOrder.items || []).reduce((sum, item) => {
                        const cat = (item.category || '').toLowerCase();
                        const name = (item.name || '').toLowerCase();
                        const isCoffeeCat = cat === 'café' || cat === 'bebidas' || cat === 'coffee' || cat === 'bebida';
                        const isCoffeeName = name.includes('latte') || name.includes('cappuccino') || name.includes('café') || name.includes('cafe') || name.includes('espresso') || name.includes('macchiato');
                        if (isCoffeeCat || isCoffeeName) {
                            return sum + (parseInt(item.qty) || 1);
                        }
                        return sum;
                    }, 0);

                    if (coffeeItemsCount > 0) {
                        const { data: customer } = await supabase.from('customers').select('*').eq('id', finalCustomerId).single();
                        if (customer) {
                            let currentStamps = 0;
                            let hasStampsColumn = 'stamps' in customer;

                            if (hasStampsColumn) {
                                currentStamps = parseInt(customer.stamps) || 0;
                            } else {
                                const tags = Array.isArray(customer.tags) ? customer.tags : [];
                                const stampTag = tags.find(t => t.startsWith('stamps:'));
                                if (stampTag) {
                                    currentStamps = parseInt(stampTag.split(':')[1]) || 0;
                                }
                            }

                            let newStamps = currentStamps + coffeeItemsCount;
                            let spinsAwarded = 0;

                            if (newStamps >= 10) {
                                spinsAwarded = Math.floor(newStamps / 10);
                                newStamps = newStamps % 10;
                            }

                            const updates = {};
                            if (hasStampsColumn) {
                                updates.stamps = newStamps;
                            } else {
                                const tags = Array.isArray(customer.tags) ? customer.tags : [];
                                const cleanTags = tags.filter(t => !t.startsWith('stamps:'));
                                cleanTags.push(`stamps:${newStamps}`);
                                updates.tags = cleanTags;
                            }

                            if (spinsAwarded > 0) {
                                const pointsBonus = spinsAwarded * 10; // 10 points = 1 Gacha Spin
                                updates.points = (parseInt(customer.points) || 0) + pointsBonus;
                                console.log(`[StampCard] Customer ${finalCustomerId} completed card. Awarded ${spinsAwarded} Gacha spins (+${pointsBonus} points).`);
                            }

                            await supabase.from('customers').update(updates).eq('id', customer.id);
                            console.log(`[StampCard] Customer ${finalCustomerId} stamps updated: ${currentStamps} -> ${newStamps} (+${spinsAwarded * 10} points)`);
                        }
                    }
                } catch (stampErr) {
                    console.error("[StampCard] Failed to process stamps:", stampErr);
                }
            }

            // --- Restaurant-Specific Digital Stamp Card Logic (QuimiEats Marketplace) ---
            const targetPhone = cleanPhone || (customer ? customer.phone : null);
            if (targetPhone && targetResId) {
                try {
                    const { data: resInfo } = await supabase.from('restaurants')
                        .select('loyalty_enabled, loyalty_stamp_goal, loyalty_reward_text')
                        .eq('id', targetResId)
                        .maybeSingle();

                    const isLoyaltyEnabled = resInfo ? (resInfo.loyalty_enabled !== false) : true;
                    const stampGoal = resInfo?.loyalty_stamp_goal || 6;
                    const rewardText = resInfo?.loyalty_reward_text || '1 Producto Gratis';

                    if (isLoyaltyEnabled) {
                        const { data: card } = await supabase.from('restaurant_loyalty_cards')
                            .select('*')
                            .eq('restaurant_id', targetResId)
                            .eq('customer_phone', targetPhone)
                            .maybeSingle();

                        let currentStamps = card ? (card.stamps_count || 0) : 0;
                        let earnedRewards = card ? (card.rewards_earned || 0) : 0;
                        let newStamps = currentStamps + 1; // 1 order = 1 stamp
                        let newRewards = earnedRewards;

                        if (newStamps >= stampGoal) {
                            newRewards += Math.floor(newStamps / stampGoal);
                            newStamps = newStamps % stampGoal;
                        }

                        if (card) {
                            await supabase.from('restaurant_loyalty_cards').update({
                                customer_id: finalCustomerId || card.customer_id,
                                stamps_count: newStamps,
                                stamps_goal: stampGoal,
                                rewards_earned: newRewards,
                                reward_description: rewardText,
                                updated_at: new Date().toISOString()
                            }).eq('id', card.id);
                        } else {
                            await supabase.from('restaurant_loyalty_cards').insert({
                                restaurant_id: targetResId,
                                customer_phone: targetPhone,
                                customer_id: finalCustomerId,
                                stamps_count: newStamps,
                                stamps_goal: stampGoal,
                                rewards_earned: newRewards,
                                reward_description: rewardText,
                                updated_at: new Date().toISOString()
                            });
                        }
                        console.log(`[RestaurantLoyalty] Stamp added for ${targetPhone} at ${targetResId}. Now: ${newStamps}/${stampGoal} (Rewards: ${newRewards})`);
                    }
                } catch (rLoyaltyErr) {
                    console.error("[RestaurantLoyalty] Failed to process restaurant stamp card:", rLoyaltyErr);
                }
            }

            // Inventory (Rich Aroma Only)
            if (targetResId === 'rich-aroma') {
                await deductInventoryForOrder(dbOrder.items, supabase);
            }
            // Email Notification (Every order triggers an email)
            await notifyOrder(data);
        })();

        // The wallet split rides the response so the POS can show it on
        // the receipt ("🎁 Regalo L.X · 💵 Tu dinero L.Y").
        if (ricoAmountPaid > 0 || ricoBonusUsed > 0) {
            data.rico_split = { bonus: ricoBonusUsed, paid: round2(ricoAmountPaid - ricoBonusUsed) };
        }

        // Ensure caller receives delivery_pin even if database stripped the custom column
        if (dbOrder.delivery_pin && !data.delivery_pin) {
            data.delivery_pin = dbOrder.delivery_pin;
        } else if (!data.delivery_pin && data.notes) {
            const pinMatch = data.notes.match(/\[DELIVERY_PIN:\s*(\d{4})\]/);
            if (pinMatch) data.delivery_pin = pinMatch[1];
        }

        return data;

    } catch (e) {
        console.error("[OrderService] Order Creation Failed:", e);
        throw e;
    }
}

module.exports = {
    createOrder,
    _promoEligibleCap: promoEligibleCap,
    _displayPriceFor: displayPriceFor,
    _verifyStaffBearer: verifyStaffBearer
};
