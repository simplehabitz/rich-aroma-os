// api/topup.js
const { supabase } = require('./supabase');

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const { imageBase64, phone, amount, bonus, fileName } = req.body;
        
        if (!phone || !imageBase64 || !amount) {
            return res.status(400).json({ error: 'Missing data' });
        }

        // 1. Get Customer
        const { data: customer, error: custErr } = await supabase
            .from('customers')
            .select('id, name')
            .eq('phone', phone.replace(/\D/g, ''))
            .single();

        if (custErr || !customer) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        // 2. Upload to Supabase Storage
        const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
        const buffer = Buffer.from(base64Data, 'base64');
        const mimeType = imageBase64.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/png';
        const ext = mimeType.split('/')[1] || 'png';
        
        const cleanName = (fileName || 'topup').replace(/[^a-zA-Z0-9.]/g, '');
        const storagePath = `receipts/TOPUP_${customer.id}_${Date.now()}_${cleanName}.${ext}`;

        const { error: uploadError } = await supabase.storage
            .from('menu-images')
            .upload(storagePath, buffer, {
                contentType: mimeType,
                upsert: true
            });

        if (uploadError) throw uploadError;

        const { data: { publicUrl } } = supabase.storage
            .from('menu-images')
            .getPublicUrl(storagePath);

        // 3. Create a Top-up Order for Admin Approval
        const { data: maxOrder } = await supabase.from('orders').select('order_number').order('order_number', { ascending: false }).limit(1);
        const orderNum = (maxOrder?.[0]?.order_number || 0) + 1;
        const id = `TOPUP-${Date.now()}`;

        const totalToCredit = parseFloat(amount) + (parseFloat(bonus) || 0);

        const { data: savedOrder, error: orderErr } = await supabase.from('orders').insert({
            id,
            order_number: orderNum,
            customer_id: customer.id,
            items: [{
                id: 'rico_cash_reload',
                name: `Recarga Rico Cash (+L.${bonus} Bono)`,
                price: parseFloat(amount),
                qty: 1,
                finalPrice: totalToCredit // This is what will be credited on approval
            }],
            subtotal: parseFloat(amount),
            total: parseFloat(amount),
            payment_method: 'transfer',
            status: 'pending_verification',
            notes: `[RECARGA] [RECEIPT_URL:${publicUrl}]`
        }).select().single();

        if (orderErr) throw orderErr;

        return res.status(200).json({ success: true, order: savedOrder });

    } catch (error) {
        console.error('Topup Error:', error);
        return res.status(500).json({ error: error.message });
    }
}
