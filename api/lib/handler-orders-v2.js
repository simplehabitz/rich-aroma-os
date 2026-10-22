const { createOrder } = require('./order-service');

module.exports = async (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();

    if (req.method === 'POST') {
        try {
            const order = await createOrder(req.body);
            return res.status(201).json(order);
        } catch (e) {
            console.error("[V2 API] Error creating order:", e.message);
            return res.status(e.message === 'Saldo insuficiente en Rico Cash' ? 400 : 500).json({ 
                error: e.message 
            });
        }
    }

    return res.status(405).json({ error: 'Method not allowed' });
};
