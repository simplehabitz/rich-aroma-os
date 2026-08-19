const fetch = require('node-fetch');

/**
 * Shared email service using Resend API.
 */
async function sendEmail({ to, subject, html, from }) {
    if (!process.env.RESEND_API_KEY) {
        console.warn("[Email Service] RESEND_API_KEY not found. Skipping email.");
        return;
    }

    const recipients = Array.isArray(to) ? to : [to];

    try {
        const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
            },
            body: JSON.stringify({
                from: from || process.env.FROM_EMAIL || 'Rich Aroma <orders@richaromacoffee.com>',
                to: recipients,
                subject,
                html
            })
        });

        const data = await res.json();
        if (!res.ok) {
            console.error("[Email Service] Resend Error:", data);
            return { error: true, details: data };
        }
        
        console.log("[Email Service] Sent successfully to:", recipients.join(', '));
        return data;
    } catch (err) {
        console.error("[Email Service] Runtime Error:", err.message);
        return { error: true, message: err.message };
    }
}

/**
 * Specific notification for Cali Distro orders.
 */
async function notifyCaliOrder(order, type = 'PAID') {
    const ownerEmail = process.env.OWNER_EMAIL || 'racs01@gmail.com';
    const extraEmail = 'boredneenee@gmail.com';
    
    const subject = `[CALI ${type}] Nuevo Pedido de Botellas - ${order.customer_name || 'Invitado'}`;
    const html = `
        <div style="font-family: sans-serif; max-width: 600px; margin: auto; border: 1px solid #eee; padding: 20px;">
            <h2 style="color: #C9A66B;">Rich Aroma Cali Distro</h2>
            <p>Se ha recibido un nuevo pedido <strong>${type}</strong>.</p>
            <hr />
            <p><strong>ID:</strong> ${order.id}</p>
            <p><strong>Cliente:</strong> ${order.customer_name}</p>
            <p><strong>Teléfono:</strong> ${order.customer_phone || 'No provisto'}</p>
            <p><strong>Total:</strong> $${order.total || '0.00'}</p>
            <div style="background: #f9f9f9; padding: 15px; border-radius: 10px; margin-top: 10px;">
                <p><strong>Detalles:</strong></p>
                <pre>${order.notes || 'Sin notas'}</pre>
            </div>
            <p style="font-size: 10px; color: #aaa; margin-top: 20px;">
                Este es un mensaje automático del sistema Rich Aroma OS.
            </p>
        </div>
    `;

    return await sendEmail({
        to: [ownerEmail, extraEmail],
        subject,
        html
    });
}

/**
 * Generic notification for any order in the OS (Coffee, Food, or QuimiEats)
 */
async function notifyOrder(order, type = 'NEW') {
    const ownerEmail = process.env.OWNER_EMAIL || 'racs01@gmail.com';
    const restaurantName = order.restaurant_id === 'rich-aroma' ? 'Rich Aroma Coffee' : order.restaurant_id.toUpperCase();
    
    const subject = `[${restaurantName}] ${type} Pedido #${order.order_number || ''}`;
    
    let itemsHtml = (order.items || []).map(i => `
        <div style="padding: 8px 0; border-bottom: 1px solid #eee;">
            <span style="font-weight: bold;">${i.qty}x ${i.name}</span> 
            <span style="color: #666; font-size: 11px;">(L. ${parseFloat(i.price).toFixed(2)})</span>
        </div>
    `).join('');

    const html = `
        <div style="font-family: sans-serif; max-width: 600px; margin: auto; border: 1px solid #eee; padding: 20px;">
            <div style="text-align: center; margin-bottom: 20px;">
                <h2 style="color: #C9A66B; margin: 0;">${restaurantName}</h2>
                <p style="color: #666; font-size: 12px; text-transform: uppercase;">Nuevo Pedido Recibido</p>
            </div>
            <div style="background: #fdfaf6; padding: 20px; border-radius: 12px; margin-bottom: 20px;">
                <p style="margin: 5px 0;"><strong>ID:</strong> ${order.id}</p>
                <p style="margin: 5px 0;"><strong>Pago:</strong> ${order.payment_method || 'N/A'}</p>
                <p style="margin: 5px 0;"><strong>Entrega:</strong> ${order.fulfillment || 'Pickup'}</p>
                ${order.scheduled_for ? `<p style="margin: 5px 0; color: #d97706;"><strong>PROGRAMADO:</strong> ${new Date(order.scheduled_for).toLocaleString()}</p>` : ''}
            </div>
            <div style="margin-bottom: 20px;">
                <h3 style="font-size: 14px; text-transform: uppercase; color: #999; border-bottom: 2px solid #C9A66B; padding-bottom: 5px;">Detalle de Orden</h3>
                ${itemsHtml}
                <div style="text-align: right; padding-top: 15px;">
                    <p style="font-size: 18px; font-weight: bold;">Total: L. ${parseFloat(order.total).toFixed(2)}</p>
                </div>
            </div>
            ${order.notes ? `<div style="background: #eee; padding: 10px; border-radius: 8px; font-size: 12px; margin-bottom: 20px;"><strong>Notas:</strong> ${order.notes}</div>` : ''}
            <p style="font-size: 10px; color: #aaa; text-align: center;">Rich Aroma OS • Quimistán, Honduras</p>
        </div>
    `;

    return await sendEmail({
        to: [ownerEmail],
        subject,
        html
    });
}

/**
 * Customer receipt email for Cali Distro / Pay orders.
 */
async function sendCustomerCaliReceipt(order, customerEmail) {
    if (!customerEmail) return { error: true, message: 'No customer email provided' };

    const selections = order.selections || {};
    const cartItems = selections.cart || [];
    const isPreorder = !!selections.preorder_date;
    const orderId = order.id ? (order.id.startsWith('RA-') ? order.id : `RA-${order.id.slice(0, 8).toUpperCase()}`) : 'RA-CALI';
    const dateFormatted = new Date(order.created_at || Date.now()).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
    });

    let itemsHtml = '';
    if (cartItems.length > 0) {
        itemsHtml = cartItems.map(item => {
            const sel = (item.selections && item.selections[0]) ? item.selections[0] : {};
            const isBlack = item.name && (item.name.toLowerCase().includes('classic black') || item.name.toLowerCase().includes('negro'));
            const customNotes = isBlack 
                ? `${sel.espresso || '3oz (strong)'} Strength` 
                : `${sel.milk || 'Regular Milk'} • ${sel.espresso || '2oz (standard)'} Strength`;
            const priceStr = item.total ? `$${parseFloat(item.total).toFixed(2)}` : (item.unitPrice ? `$${parseFloat(item.unitPrice).toFixed(2)}` : '');

            return `
                <tr>
                    <td style="padding: 10px 0; border-bottom: 1px solid #f0ece1; vertical-align: top;">
                        <strong style="color: #120e0c; font-size: 14px;">${item.qty || 1}x ${item.name}</strong>
                        <div style="font-size: 11px; color: #8b5a2b; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 3px;">
                            ${customNotes}
                        </div>
                    </td>
                    <td style="padding: 10px 0; border-bottom: 1px solid #f0ece1; text-align: right; vertical-align: top; font-weight: bold; color: #120e0c; font-size: 14px;">
                        ${priceStr}
                    </td>
                </tr>
            `;
        }).join('');
    } else {
        itemsHtml = `
            <tr>
                <td style="padding: 10px 0; border-bottom: 1px solid #f0ece1;">
                    <strong style="color: #120e0c;">Artisanal Bottled Coffee</strong>
                </td>
                <td style="padding: 10px 0; border-bottom: 1px solid #f0ece1; text-align: right; font-weight: bold; color: #120e0c;">
                    $${parseFloat(order.total || 0).toFixed(2)}
                </td>
            </tr>
        `;
    }

    let fulfillmentBadge = '';
    if (isPreorder) {
        const d = new Date(selections.preorder_date + 'T00:00:00');
        const formattedDropDate = !isNaN(d) ? d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) : selections.preorder_date;
        fulfillmentBadge = `
            <div style="background: #fdfaf6; border: 1px solid #d4af37; border-radius: 12px; padding: 14px; margin: 18px 0; text-align: center;">
                <p style="margin: 0; font-size: 11px; font-weight: 800; color: #8b5a2b; text-transform: uppercase; letter-spacing: 1px;">Pre-Order Drop Delivery</p>
                <p style="margin: 4px 0 0 0; font-size: 15px; font-weight: bold; color: #120e0c;">${formattedDropDate}</p>
                <p style="margin: 4px 0 0 0; font-size: 11px; color: #666;">Freshly brewed and hand-delivered labeled with your name.</p>
            </div>
        `;
    } else {
        fulfillmentBadge = `
            <div style="background: #fdfaf6; border: 1px solid #e5e0d8; border-radius: 12px; padding: 14px; margin: 18px 0; text-align: center;">
                <p style="margin: 0; font-size: 11px; font-weight: 800; color: #8b5a2b; text-transform: uppercase; letter-spacing: 1px;">Fridge Pickup</p>
                <p style="margin: 4px 0 0 0; font-size: 13px; font-weight: 600; color: #120e0c;">Take your bottle directly from the fridge. Verified!</p>
            </div>
        `;
    }

    let stampsSection = '';
    if (typeof selections.stamps_after === 'number') {
        stampsSection = `
            <div style="background: #120e0c; color: #fff; border-radius: 12px; padding: 14px; margin: 18px 0; text-align: center;">
                <p style="margin: 0; font-size: 10px; font-weight: 800; color: #d4af37; text-transform: uppercase; letter-spacing: 1.5px;">Loyalty Stamp Card</p>
                <p style="margin: 4px 0 0 0; font-size: 18px; font-weight: 900; color: #fff;">${selections.stamps_after} / 9 Stamps</p>
                <p style="margin: 4px 0 0 0; font-size: 11px; color: #ccc;">Collect 9 stamps, get your 10th artisanal bottle FREE!</p>
            </div>
        `;
    }

    const html = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 540px; margin: auto; background: #fdfbf7; border: 1px solid #ebe5dc; border-radius: 20px; overflow: hidden; color: #120e0c;">
            
            <!-- Header -->
            <div style="background: #120e0c; padding: 26px 20px; text-align: center; border-bottom: 2px solid #d4af37;">
                <h1 style="color: #fdfbf7; font-size: 22px; font-weight: 900; letter-spacing: 1.5px; margin: 0; text-transform: uppercase; font-family: Georgia, serif;">Rich Aroma</h1>
                <p style="color: #d4af37; font-size: 10px; font-weight: 800; letter-spacing: 2px; text-transform: uppercase; margin: 6px 0 0 0;">Artisanal Brewed Chilled Espresso</p>
            </div>

            <div style="padding: 24px 24px 30px 24px;">
                
                <!-- Receipt Metadata -->
                <div style="display: flex; justify-content: space-between; border-bottom: 1px dashed #d5cebf; padding-bottom: 14px; margin-bottom: 16px;">
                    <div>
                        <p style="margin: 0; font-size: 10px; text-transform: uppercase; color: #888; font-weight: 700; letter-spacing: 0.5px;">Receipt Code</p>
                        <p style="margin: 2px 0 0 0; font-size: 15px; font-weight: 900; color: #8b5a2b; font-family: monospace;">${orderId}</p>
                    </div>
                    <div style="text-align: right;">
                        <p style="margin: 0; font-size: 10px; text-transform: uppercase; color: #888; font-weight: 700; letter-spacing: 0.5px;">Date</p>
                        <p style="margin: 2px 0 0 0; font-size: 12px; font-weight: 700; color: #120e0c;">${dateFormatted}</p>
                    </div>
                </div>

                ${order.customer_name ? `
                    <p style="margin: 0 0 16px 0; font-size: 13px; color: #444;">
                        Customer: <strong style="color: #120e0c;">${order.customer_name}</strong>
                    </p>
                ` : ''}

                <!-- Items Table -->
                <table style="width: 100%; border-collapse: collapse; margin-bottom: 16px;">
                    <thead>
                        <tr style="border-bottom: 2px solid #8b5a2b;">
                            <th style="text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: #8b5a2b; padding-bottom: 6px;">Item</th>
                            <th style="text-align: right; font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: #8b5a2b; padding-bottom: 6px;">Price</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${itemsHtml}
                    </tbody>
                </table>

                <!-- Total -->
                <div style="text-align: right; margin-top: 14px; padding-top: 10px; border-top: 1px solid #120e0c;">
                    <p style="margin: 0; font-size: 11px; text-transform: uppercase; color: #888; letter-spacing: 1px;">Total Paid</p>
                    <p style="margin: 2px 0 0 0; font-size: 24px; font-weight: 900; color: #8b5a2b; font-family: monospace;">$${parseFloat(order.total || 0).toFixed(2)}</p>
                </div>

                <!-- Fulfillment details -->
                ${fulfillmentBadge}

                <!-- Stamp Card -->
                ${stampsSection}

                <!-- Customer Message -->
                <div style="text-align: center; margin-top: 26px; padding-top: 20px; border-top: 1px dashed #d5cebf;">
                    <p style="margin: 0; font-size: 14px; font-style: italic; font-weight: 700; color: #8b5a2b; font-family: Georgia, serif;">
                        "Enjoy your fresh Honduran Artisan Bottled Coffee ☕"
                    </p>
                    <p style="margin: 8px 0 0 0; font-size: 10px; color: #999; text-transform: uppercase; letter-spacing: 1px;">
                        100% Single-Origin Small Batch Espresso • Quimistán, Honduras
                    </p>
                </div>

            </div>

        </div>
    `;

    return await sendEmail({
        to: [customerEmail],
        subject: `Your Rich Aroma Receipt [${orderId}]`,
        html
    });
}

module.exports = {
    sendEmail,
    notifyCaliOrder,
    notifyOrder,
    sendCustomerCaliReceipt
};

