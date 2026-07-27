const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { supabase } = require('./lib/supabase');
const { sendEmail, notifyCaliOrder } = require('./lib/email-service');
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

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        if (!process.env.STRIPE_WEBHOOK_SECRET) {
            event = req.body; 
        } else {
            return res.status(400).send(`Webhook Error: ${err.message}`);
        }
    }

    try {
        // 1. Handle initial successful payment (One-time or first Subscription charge)
        if (event.type === 'checkout.session.completed') {
            const session = event.data.object;
            const orderId = session.metadata.order_id;
            const isSub = session.metadata.is_subscription === 'true';
            const customerEmail = session.metadata.customer_email || session.customer_details?.email;

            if (session.metadata.type === 'cali_distro' && orderId) {
                // Update the initial order to paid
                const { data: updatedOrder } = await supabase.from('cali_orders').update({ 
                    status: 'paid',
                    notes: `[PAID] Stripe Session: ${session.id}` 
                }).eq('id', orderId).select().single();

                // Decrement inventory stock if limits are set (Only for Honors Grab checkouts, not Pre-Orders)
                const isPreorder = updatedOrder && updatedOrder.selections && updatedOrder.selections.preorder_date;
                if (updatedOrder && updatedOrder.selections && updatedOrder.selections.cart && !isPreorder) {
                    const cartItems = updatedOrder.selections.cart;
                    const productIds = cartItems.map(item => item.product_id).filter(id => id && id !== 'catering_event_pack');
                    if (productIds.length > 0) {
                        const { data: dbProducts } = await supabase
                            .from('cali_products')
                            .select('id, inventory_limit, options')
                            .in('id', productIds);
                        
                        if (dbProducts) {
                            for (const item of cartItems) {
                                if (item.product_id === 'catering_event_pack') continue;
                                const dbP = dbProducts.find(p => p.id === item.product_id);
                                if (dbP) {
                                    let updatedOptions = dbP.options;
                                    const milkStock = dbP.options?.milk_stock;
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
                                            updatedOptions = { ...dbP.options, milk_stock: newMilkStock };
                                        }
                                    }

                                    let newGlobalStock = dbP.inventory_limit;
                                    let needsGlobalUpdate = false;
                                    if (dbP.inventory_limit !== null) {
                                        const count = (item.selections && Array.isArray(item.selections)) ? item.selections.length : 1;
                                        const qtyNeeded = count * parseInt(item.qty || 1);
                                        newGlobalStock = Math.max(0, dbP.inventory_limit - qtyNeeded);
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
                    }
                }

                // Send Confirmation Emails
                if (customerEmail) {
                    await sendEmail({
                        to: customerEmail,
                        subject: 'Order Confirmed - Rich Aroma Cali Distro',
                        html: `<h1>Thank you for your order!</h1><p>We've received your payment for order <strong>${orderId}</strong>.</p><p>We will brew your batch this Sunday and deliver it fresh Monday morning.</p>`
                    });
                }

                // Notify Owners
                if (updatedOrder) {
                    await notifyCaliOrder(updatedOrder, 'PAID');
                }

                // If it's a subscription, create the record in cali_subscriptions
                if (isSub && session.subscription) {
                    const sub = await stripe.subscriptions.retrieve(session.subscription);
                    
                    // Get selections from the original order
                    const { data: originalOrder } = await supabase.from('cali_orders').select('*').eq('id', orderId).single();

                    if (originalOrder) {
                        await supabase.from('cali_subscriptions').insert({
                            customer_name: originalOrder.customer_name,
                            customer_email: customerEmail || '',
                            customer_phone: originalOrder.customer_phone,
                            location_id: originalOrder.location_id,
                            selections: originalOrder.selections,
                            stripe_subscription_id: session.subscription,
                            stripe_customer_id: session.customer,
                            status: 'active',
                            total: originalOrder.total
                        });
                    }
                }
            }
        }

        // 2. Handle recurring subscription payments
        if (event.type === 'invoice.paid') {
            const invoice = event.data.object;
            if (invoice.subscription) {
                const { data: sub } = await supabase
                    .from('cali_subscriptions')
                    .select('*')
                    .eq('stripe_subscription_id', invoice.subscription)
                    .single();

                if (sub && sub.status === 'active') {
                    // Create a new order for this week's delivery
                    const { data: newOrder } = await supabase.from('cali_orders').insert({
                        customer_name: sub.customer_name,
                        customer_email: sub.customer_email || '',
                        customer_phone: sub.customer_phone,
                        location_id: sub.location_id,
                        total: sub.total,
                        status: 'paid',
                        selections: sub.selections,
                        subscription_id: sub.id,
                        notes: `[RECURRING] Week of ${new Date().toLocaleDateString()}\nStripe Invoice: ${invoice.id}`
                    }).select().single();

                    // Decrement inventory stock if limits are set (Only for Honors Grab checkouts, not Pre-Orders)
                    const isPreorder = newOrder && newOrder.selections && newOrder.selections.preorder_date;
                    if (newOrder && newOrder.selections && newOrder.selections.cart && !isPreorder) {
                        const cartItems = newOrder.selections.cart;
                        const productIds = cartItems.map(item => item.product_id).filter(id => id && id !== 'catering_event_pack');
                        if (productIds.length > 0) {
                            const { data: dbProducts } = await supabase
                                .from('cali_products')
                                .select('id, inventory_limit, options')
                                .in('id', productIds);
                            
                            if (dbProducts) {
                                for (const item of cartItems) {
                                    if (item.product_id === 'catering_event_pack') continue;
                                    const dbP = dbProducts.find(p => p.id === item.product_id);
                                    if (dbP) {
                                        let updatedOptions = dbP.options;
                                        const milkStock = dbP.options?.milk_stock;
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
                                                updatedOptions = { ...dbP.options, milk_stock: newMilkStock };
                                            }
                                        }

                                        let newGlobalStock = dbP.inventory_limit;
                                        let needsGlobalUpdate = false;
                                        if (dbP.inventory_limit !== null) {
                                            const count = (item.selections && Array.isArray(item.selections)) ? item.selections.length : 1;
                                            const qtyNeeded = count * parseInt(item.qty || 1);
                                            newGlobalStock = Math.max(0, dbP.inventory_limit - qtyNeeded);
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
                        }
                    }

                    // Notify Customer of recurring order
                    if (newOrder) {
                        await notifyCaliOrder(newOrder, 'RECURRING');
                    }

                    if (sub.customer_email) {
                        await sendEmail({
                            to: sub.customer_email,
                            subject: 'Recurring Order Processed - Rich Aroma',
                            html: `<h1>Your weekly batch is being prepared!</h1><p>Your subscription payment for the week of ${new Date().toLocaleDateString()} was successful.</p>`
                        });
                    }
                }
            }
        }

        // 3. Handle Subscription Cancellations
        if (event.type === 'customer.subscription.deleted') {
            const subscription = event.data.object;
            await supabase
                .from('cali_subscriptions')
                .update({ status: 'canceled' })
                .eq('stripe_subscription_id', subscription.id);
        }

        res.json({ received: true });
    } catch (error) {
        console.error('Webhook processing error:', error);
        res.status(500).json({ error: error.message });
    }
};
