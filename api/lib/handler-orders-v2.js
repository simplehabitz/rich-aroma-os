const { createOrder } = require('./order-service');

module.exports = async (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();

    if (req.method === 'POST') {
        try {
            // SEC-FIX 2: forward the caller's Bearer credential so
            // order-service can authorize Rico Cash debits (staff POS flow)
            // and staff manual discounts. Absent/invalid Bearer is fine for
            // cash/transfer/bot orders — it only gates wallet debits.
            const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
            const bearer = String(authHeader).replace(/^Bearer\s+/i, '').trim() || null;
            const order = await createOrder(req.body, undefined, { bearer });
            return res.status(201).json(order);
        } catch (e) {
            console.error("[V2 API] Error creating order:", e.message);
            const status = e.status === 401 ? 401
                : (e.status === 400 || e.message === 'Saldo insuficiente en Rico Cash') ? 400
                : 500;
            const body = { error: e.message };
            if (e.code) body.code = e.code;
            return res.status(status).json(body);
        }
    }

    return res.status(405).json({ error: 'Method not allowed' });
};
