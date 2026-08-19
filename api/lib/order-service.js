const { supabase: defaultSupabase } = require('./supabase');
const { awardPoints, syncMembershipState, getHondurasDate } = require('./loyalty');
const { applyVipBenefits, applyBootcampBenefits, calculateSurgeDiscounts } = require('./pricing');
const { deductInventoryForOrder } = require('./inventory-service');
const { notifyOrder } = require('./email-service');

/**
 * Main Order Orchestrator for Rich Aroma OS & QuimiEats
 */
async function createOrder(orderRequest, supabase = defaultSupabase) {
    const items = orderRequest.items;
    const paymentMethod = orderRequest.paymentMethod || orderRequest.payment_method;
    const secondaryPaymentMethod = orderRequest.secondaryPaymentMethod || orderRequest.secondary_payment_method;
    const ricoAmount = orderRequest.ricoAmount || orderRequest.rico_amount;
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
    const category = orderRequest.category;

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

        // 2. Pricing & Meta Logic
        const itemIds = (items || []).map(i => i.id);
        const { data: menuItems } = await supabase.from('menu_items').select('id, category, is_house_made, is_vip_free_eligible').in('id', itemIds);
        
        const itemsWithMeta = (items || []).map(item => {
            const meta = (menuItems || []).find(m => m.id === item.id);
            return {
                ...item,
                category: meta?.category || 'General',
                is_house_made: meta?.is_house_made || false,
                is_vip_free_eligible: meta?.is_vip_free_eligible || false
            };
        });

        // Surge Engine (Rich Aroma Only for now)
        let surgeDiscount = 0;
        if (targetResId === 'rich-aroma') {
            const { data: activeSurges } = await supabase.from('surge_deals')
                .select('*')
                .eq('active', true)
                .gt('expires_at', new Date().toISOString());
            surgeDiscount = calculateSurgeDiscounts(itemsWithMeta, activeSurges || []);
        }

        // VIP Engine
        let finalOrderData = {
            items: itemsWithMeta,
            subtotal: orderRequest.subtotal || itemsWithMeta.reduce((sum, i) => sum + (parseFloat(i.price) * (i.qty || 1)), 0),
            total: orderRequest.total || (itemsWithMeta.reduce((sum, i) => sum + (parseFloat(i.price) * (i.qty || 1)), 0) - surgeDiscount),
            discount: orderRequest.discount || surgeDiscount,
            tier: 'Basic'
        };

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
                // If POS sent a total, keep it, otherwise use VIP calc
                if (!orderRequest.total) {
                    finalOrderData.total = vipCalc.total - surgeDiscount;
                    finalOrderData.discount += vipCalc.items.reduce((sum, i) => sum + (i.appliedDiscount || 0), 0);
                }
                finalOrderData.tier = vipCalc.tier;
                
                if (vipCalc.freeDrinkClaimed) {
                    await supabase.from('customers').update({ last_free_drink_date: getHondurasDate() }).eq('id', customer.id);
                }
            } else if (tags.includes('Bootcamp')) {
                const bootCalc = applyBootcampBenefits(itemsWithMeta, customer);
                finalOrderData.items = bootCalc.items;
                if (!orderRequest.total) {
                    finalOrderData.total = bootCalc.total - surgeDiscount;
                    finalOrderData.discount += bootCalc.items.reduce((sum, i) => sum + (i.appliedDiscount || 0), 0);
                }
                finalOrderData.tier = 'Bootcamp';
            }
        }

        // 3. Rico Balance Logic
        let orderStatus = 'pending';
        let ricoAmountPaid = 0;
        if (paymentMethod === 'rico_balance' && customer) {
            const currentBalance = parseFloat(customer.rico_balance) || 0;
            if (currentBalance >= finalOrderData.total) {
                orderStatus = 'paid';
                ricoAmountPaid = finalOrderData.total;
                await supabase.from('customers').update({ rico_balance: currentBalance - finalOrderData.total }).eq('id', customer.id);
                await supabase.from('balance_history').insert({
                    customer_id: customer.id,
                    type: 'payment',
                    amount: -finalOrderData.total,
                    notes: `Order #${finalOrderData.total}`
                });
            } else if (currentBalance > 0) {
                orderStatus = 'partial_paid';
                ricoAmountPaid = currentBalance;
                await supabase.from('customers').update({ rico_balance: 0 }).eq('id', customer.id);
                await supabase.from('balance_history').insert({
                    customer_id: customer.id,
                    type: 'payment',
                    amount: -currentBalance,
                    notes: `Partial Order #${currentBalance}`
                });
            } else {
                throw new Error('Saldo insuficiente en Rico Cash');
            }
        }

        // 4. Create Order
        const orderNum = Math.floor(Date.now() / 1000) - 1769000000;
        const orderId = 'ORD-' + Date.now() + '-' + Math.floor(Math.random() * 1000);

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
            customer_id: finalCustomerId,
            restaurant_id: targetResId,
            shift_id: shiftId,
            scheduled_for: scheduledFor,
            notes: (finalOrderData.tier !== 'Basic' ? `[STATUS: ${finalOrderData.tier.toUpperCase()}] [SALUDO: ${(customer?.name || '').split(' ')[0].toUpperCase()}] ` : '') + 
                   `[FULFILLMENT: ${fulfillment || 'pickup'}] ` + 
                   (guestPhone ? `[TEL: ${guestPhone}] ` : '') + 
                   (notes || '')
        };

        if (fulfillment === 'delivery') {
            const deliveryPin = Math.floor(1000 + Math.random() * 9000).toString();
            dbOrder.delivery_pin = deliveryPin;
            dbOrder.notes = (dbOrder.notes || '') + ` [DELIVERY_PIN: ${deliveryPin}]`;
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
            if (errorMsg.includes('orders_restaurant_id_fkey')) {
                fallbackOrder.notes = (fallbackOrder.notes || '') + ` [ORIGINAL_RESTAURANT: ${targetResId}]`;
                fallbackOrder.restaurant_id = 'rich-aroma';
            }
            
            const retry = await supabase.from('orders').insert(fallbackOrder).select().single();
            data = retry.data;
            error = retry.error;
        }
        if (error) {
            console.error("[OrderService] Order Creation Failed:", error);
            throw error;
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

                    // B. Credit order total to merchant if paid via platform-held channels (rico_balance, transfer)
                    const isPlatformHeld = paymentMethod === 'rico_balance' || paymentMethod === 'rico_cash' || paymentMethod === 'transfer';
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

        return data;

    } catch (e) {
        console.error("[OrderService] Order Creation Failed:", e);
        throw e;
    }
}

module.exports = {
    createOrder
};
