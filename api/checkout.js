const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { supabase } = require('./lib/supabase');
const { notifyCaliOrder } = require('./lib/email-service');

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const { name, email, phone, location_id, items, notes, promo_code, is_subscription } = req.body;

        if (!items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: 'Cart is empty' });
        }

        const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.richaromacoffee.com';
        
        // 1. Check Promo Code / Subscription Discount
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

        // 1.5 Calculate total bottles (excluding catering) for volume discount trigger
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
        if (productsData && !preorder_date) {
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

        // 1.7 Calculate Stamp Card Discount (10th Bottle Free)
        let totalPaidPast = 0;
        let totalFreePast = 0;
        let stampsBefore = 0;
        let stampsAfter = 0;
        let freeRedeemedInCurrent = 0;
        let stampSavings = 0;

        if (phone) {
            const { data: pastOrders } = await supabase
                .from('cali_orders')
                .select('selections')
                .eq('customer_phone', phone)
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
            // Adjust past paid to be net of free
            totalPaidPast = Math.max(0, totalPaidPast - totalFreePast);
            stampsBefore = totalPaidPast % 9;

            // Stable allocation of free bottles for current order
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

        // Identify the cheapest standard bottles in the cart to set free
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

        // 2. Prepare Stripe Line Items and Order Notes
        const lineItems = [];
        let combinedNotes = is_subscription ? `[SUBSCRIPTION ORDER] ${notes || ''}\n` : `[CALI ORDER] ${notes || ''}\n`;
        let totalAmount = 0;
        let totalBottles = 0;

        for (const item of items) {
            let itemDescription = "";
            const itemBottles = item.selections ? item.selections.length : 1;
            totalBottles += (itemBottles * parseInt(item.qty));

            if (item.selections && Array.isArray(item.selections)) {
                itemDescription = item.selections.map((s, i) => {
                    const espStr = s.espresso || 'Standard';
                    let oz = "";
                    if (s.flavor === 'Classic Black') {
                        oz = espStr === 'Light' ? '2oz' : (espStr === 'Extra' ? '4oz' : '3oz');
                    } else {
                        oz = espStr === 'Light' ? '1oz' : (espStr === 'Extra' ? '3oz' : '2oz');
                    }
                    return `#${i+1}: ${s.flavor} (${s.milk}, ${oz} Esp)`;
                }).join(', ');
            } else {
                itemDescription = `Flavor: ${item.flavor || 'N/A'}, Milk: ${item.milk || 'N/A'}`;
            }

            // Recalculate/validate unit price on the server to prevent client manipulation
            let basePrice = 6.00; // default for flavored lattes
            if (item.product_id === 'catering_event_pack') {
                const cateringSize = item.selections ? item.selections.length : 30;
                let rate = 4.50;
                if (cateringSize >= 500) rate = 3.20;
                else if (cateringSize >= 250) rate = 3.50;
                else if (cateringSize >= 200) rate = 3.60;
                else if (cateringSize >= 150) rate = 3.80;
                else if (cateringSize >= 100) rate = 4.00;
                else if (cateringSize >= 75) rate = 4.20;
                else if (cateringSize >= 50) rate = 4.40;
                basePrice = rate * cateringSize;
            } else {
                if (priceMap[item.product_id] !== undefined) {
                    basePrice = priceMap[item.product_id];
                } else if (item.name && (item.name.toLowerCase().includes('black') || item.name.toLowerCase().includes('americano'))) {
                    basePrice = 5.00;
                }
            }

            let unitPrice = basePrice;
            if (item.product_id !== 'catering_event_pack') {
                // Add oat milk surcharge if any selection has oat milk
                let hasOatMilk = false;
                if (item.selections && Array.isArray(item.selections)) {
                    hasOatMilk = item.selections.some(s => s.milk === 'Oat Milk');
                } else {
                    hasOatMilk = item.milk === 'Oat Milk';
                }
                if (hasOatMilk) {
                    unitPrice += 1.00;
                }
                // Subtract volume discount
                unitPrice -= volumeDiscount;
            }

            if (discountPercent > 0) {
                unitPrice = unitPrice * (1 - (discountPercent / 100));
            }

            const lineItem = {
                price_data: {
                    currency: 'usd',
                    product_data: { 
                        name: item.name + (discountPercent > 0 ? ` (${discountPercent}% OFF)` : ''),
                        description: itemDescription
                    },
                    unit_amount: Math.round(unitPrice * 100),
                },
                quantity: parseInt(item.qty),
            };

            if (is_subscription) {
                lineItem.price_data.recurring = { interval: 'week' };
            }

            lineItems.push(lineItem);
            combinedNotes += `- ${item.qty}x ${item.name} [${itemDescription}]\n`;
            totalAmount += (unitPrice * item.qty);
        }

        // Deduct the stamps discount from the final totalAmount
        totalAmount = Math.max(0, totalAmount - stampSavingsDiscounted);

        if (sellerInfo) {
            const commission = totalBottles * 1.00;
            combinedNotes += `\n[PROMO: ${promo_code.toUpperCase()}] Seller: ${sellerInfo.name}\nCommission: $${commission.toFixed(2)}`;
        }

        // 3. Create initial entry in DB (as pending order)
        const { data: order, error: orderErr } = await supabase
            .from('cali_orders')
            .insert({
                customer_name: name || 'Guest',
                customer_phone: phone || '',
                location_id: location_id === 'home' ? null : location_id,
                total: totalAmount,
                selections: { 
                    cart: items, 
                    promo: promo_code ? promo_code.toUpperCase() : null,
                    discount: discountPercent,
                    seller_id: sellerInfo ? sellerInfo.id : null,
                    commission: sellerInfo ? totalBottles * 1.0 : 0,
                    is_subscription: !!is_subscription,
                    free_bottles_redeemed: freeRedeemedInCurrent,
                    stamps_before: stampsBefore,
                    stamps_after: stampsAfter
                },
                status: 'pending',
                notes: combinedNotes + `\n[STAMPS] Redeemed: ${freeRedeemedInCurrent} | Stamps: ${stampsBefore} -> ${stampsAfter}` + (email ? `\nCustomer Email: ${email}` : '')
            })
            .select()
            .single();

        if (orderErr) {
            console.error("Supabase Insert Error:", orderErr);
            throw new Error('Order creation failed (V2): ' + orderErr.message);
        }

        // Notify Owners of new pending order
        await notifyCaliOrder(order, 'PENDING');

        // 4. Create Stripe Session
        if (!process.env.STRIPE_SECRET_KEY) {
            return res.status(200).json({ 
                url: `${baseUrl}/cali?success=true&order=${order.id}`, 
                order_id: order.id 
            });
        }

        const sessionPayload = {
            customer_email: email || undefined,
            payment_method_types: ['card'],
            line_items: lineItems,
            mode: is_subscription ? 'subscription' : 'payment',
            success_url: `${baseUrl}/cali?success=true&order=${order.id}`,
            cancel_url: `${baseUrl}/cali?canceled=true`,
            metadata: { 
                order_id: order.id,
                type: 'cali_distro',
                is_subscription: is_subscription ? 'true' : 'false',
                customer_email: email || ''
            }
        };

        // CashApp not supported for subscriptions
        if (!is_subscription) sessionPayload.payment_method_types.push('cashapp');

        const session = await stripe.checkout.sessions.create(sessionPayload);

        res.status(200).json({ 
            url: session.url, 
            order_id: order.id, 
            session_id: session.id 
        });

    } catch (error) {
        console.error('Checkout error:', error);
        res.status(500).json({ error: error.message });
    }
};
