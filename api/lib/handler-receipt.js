const { supabase } = require('./supabase');

module.exports = async function handler(req, res) {
    // Only allow POST
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { id } = req.query; 
        const { imageBase64, image, orderId, fileName } = req.body;
        
        const finalImage = imageBase64 || image;
        const targetId = id || orderId;

        if (!targetId || !finalImage) {
            console.error("[Receipt] Missing data:", { targetId, hasImage: !!finalImage });
            return res.status(400).json({ error: 'Falta ID de orden o imagen' });
        }

        // Validate base64 format
        if (!finalImage.startsWith('data:image/')) {
            return res.status(400).json({ error: 'Formato de imagen inválido' });
        }

        // Convert base64 to buffer
        // More robust regex to handle different image types
        const matches = finalImage.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.*)$/);
        if (!matches || matches.length < 3) {
            return res.status(400).json({ error: 'Mecanismo de imagen no reconocido' });
        }

        const mimeType = matches[1];
        const base64Data = matches[2];
        const buffer = Buffer.from(base64Data, 'base64');
        const ext = mimeType.split('/')[1] || 'png';
        
        const cleanName = (fileName || 'receipt').replace(/[^a-zA-Z0-9.]/g, '');
        const storagePath = `receipts/${targetId}_${Date.now()}_${cleanName}.${ext}`;

        console.log("[Receipt] Uploading to Supabase:", storagePath);

        const { data, error } = await supabase.storage
            .from('menu-images')
            .upload(storagePath, buffer, {
                contentType: mimeType,
                upsert: true
            });

        if (error) throw error;

        const { data: { publicUrl } } = supabase.storage
            .from('menu-images')
            .getPublicUrl(storagePath);

        // Update Order Notes
        const { data: orderData } = await supabase.from('orders').select('notes').eq('id', targetId).maybeSingle();
        const existingNotes = orderData ? (orderData.notes || '') : '';
        const newNotes = existingNotes + '\n[RECEIPT_URL:' + publicUrl + ']';

        const { error: dbError } = await supabase
            .from('orders')
            .update({ notes: newNotes, status: 'pending_verification' })
            .eq('id', targetId);

        if (dbError) throw dbError;

        return res.status(200).json({ success: true, url: publicUrl });

    } catch (error) {
        console.error('Upload Error:', error);
        return res.status(500).json({ error: error.message });
    }
};
