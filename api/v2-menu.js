const { supabase } = require('./lib/supabase');

module.exports = async (req, res) => {
    // 1. Set Headers Immediately
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const { action, id, restaurantId, resId } = req.query;
    let finalResId = restaurantId || resId || id || 'rich-aroma';
    
    // Translation Layer
    if (finalResId && typeof finalResId === 'string') {
        const lowerId = finalResId.toLowerCase();
        if (lowerId.includes('fradas')) finalResId = 'fradas-bar--grill-445';
        else if (lowerId.includes('tony') || lowerId.includes('cerca')) finalResId = 'tonys-pizza';
        else if (lowerId.includes('meson')) finalResId = 'el-meson';
    }

    try {
        const [rItems, rModGroups, rModOptions, rItemModGroups, rBundleSlots, restaurant] = await Promise.all([
            supabase.from('menu_items').select('*').eq('restaurant_id', finalResId).order('name'),
            supabase.from('modifier_groups').select('*').order('name'),
            supabase.from('modifier_options').select('*').order('name'),
            supabase.from('item_modifier_groups').select('*'),
            supabase.from('bundle_slots').select('*'),
            supabase.from('restaurants').select('settings').eq('id', finalResId).maybeSingle()
        ]);

        const items = rItems.data || [];
        const allGroups = rModGroups.data || [];
        const allItemMods = rItemModGroups.data || [];
        const bundleSlots = rBundleSlots.error ? [] : (rBundleSlots.data || []);
        const settings = restaurant?.data?.settings || {};
        const productInventory = settings.product_inventory || {};
        const activeBatches = settings.batches || [];
        const now = new Date();

        // --- MODIFIER FILTERING ---
        const itemIds = items.map(i => i.id);
        const linkedGroupIds = allItemMods.filter(img => itemIds.includes(img.item_id)).map(img => img.group_id);
        const filteredGroups = allGroups.filter(g => g.restaurant_id === finalResId || linkedGroupIds.includes(g.id));

        // --- ITEM FILTERING & PRICING ---
        const isAdmin = req.query.admin === 'true';
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

            if (finalResId === 'rich-aroma') { 
                finalPrice = Math.round((finalPrice * 1.15) / 5) * 5; 
                originalPrice = Math.round((originalPrice * 1.15) / 5) * 5; 
            }

            return { 
                ...item, 
                price: finalPrice, 
                original_price: originalPrice, 
                promo_tag: promoTag, 
                stock_quantity: stockQuantity,
                available: isUnlimited ? item.available : (stockQuantity > 0),
                is_unlimited: isUnlimited,
                expires_in_hours: expiresInHours,
                default_daily_stock: itemConfig.default_daily_stock,
                duration: itemConfig.duration
            };
        });

        // --- CATEGORIZATION ---
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
                available: item.available, 
                stock_quantity: item.stock_quantity,
                is_unlimited: item.is_unlimited,
                expires_in_hours: item.expires_in_hours,
                image_url: item.image_url, 
                category: cat,
                default_daily_stock: item.default_daily_stock,
                duration: item.duration
            });
        });

        const categories = Object.keys(grouped).map(c => ({ id: c, name: c.charAt(0).toUpperCase() + c.slice(1), items: grouped[c] }));

        let finalItems = [...filteredItems];
        if (finalResId === 'rich-aroma') {
            const popularItemsList = [];
            const POPULAR_KEYWORDS = [
                "combo 2", "supreme frappe", "cappuccino", "coffee frappe",
                "combo 1", "combo 3", "americano", "avocado toast",
                "fresa frappe", "crepas", "baleadas"
            ];
            
            POPULAR_KEYWORDS.forEach(keyword => {
                const matchedItem = filteredItems.find(item => 
                    (item.name || '').toLowerCase().includes(keyword)
                );
                if (matchedItem) {
                    const popularCopy = {
                        ...matchedItem,
                        category: 'popular'
                    };
                    popularItemsList.push(popularCopy);
                    finalItems.push(popularCopy);
                }
            });
            
            if (popularItemsList.length > 0) {
                categories.unshift({
                    id: 'popular',
                    name: '🔥 Más Vendidos',
                    items: popularItemsList
                });
            }
        }

        // Gather items expiring in under 12 hours with active stock to push as Gacha rewards
        const expiringPrizes = filteredItems.filter(i => !i.is_unlimited && i.expires_in_hours !== undefined && i.expires_in_hours <= 12 && i.stock_quantity > 0).map(i => ({
            id: i.id,
            name: i.name,
            category: i.category
        }));

        return res.json({ 
            items: finalItems, categories, expiringPrizes, modGroups: filteredGroups, 
            modOptions: rModOptions.data || [], itemModGroups: allItemMods, 
            bundleSlots, taxRate: 0,
            acceptedPayments: settings.accepted_payments || {},
            bankDetails: settings.bank_details || {}
        });

    } catch (e) {
        console.error("[V2-Menu] Error:", e);
        res.status(500).json({ error: "Internal Server Error" });
    }
};
