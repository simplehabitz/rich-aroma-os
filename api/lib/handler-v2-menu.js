const { supabase } = require('./supabase');
const ricoLoyalty = require('./rico-loyalty');

// --- ESPECIAL DEL DÍA, public display (menu-link-pass, 2026-10-31) ---
// The lightest public read of the existing especial system: today's
// special ONLY while it is set, active, inside its hours and under
// its cap — the same state rico-loyalty.getSpecialState computes for
// the WhatsApp reveal. The headline is composed from the same data
// especialReveal reads (item name / campaign config), in the same
// customer words. Display ONLY: claiming stays on the built paths
// (WhatsApp ESPECIAL pull / server-side apply at order time). Any
// failure returns null — the menu renders exactly as before.
function fmtEspecialTime(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
    if (!m) return String(hhmm || '');
    let h = parseInt(m[1], 10);
    const suffix = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${m[2]} ${suffix}`;
}

async function buildPublicEspecial(special) {
    let headline = '';
    if (special.item_id) {
        const { data: item } = await supabase.from('menu_items')
            .select('name').eq('id', special.item_id).maybeSingle();
        headline = `Hoy tu ${item && item.name ? item.name : 'artículo especial'} va GRATIS (uno) con tu pedido 🎁`;
    } else if (special.campaign_id) {
        const { data: c } = await supabase.from('loyalty_campaigns')
            .select('*').eq('id', special.campaign_id).maybeSingle();
        const cfg = (c && c.config) || {};
        if (c && c.type === 'multiplicador') {
            headline = `Hoy el regalo por tu compra se multiplica ×${cfg.multiplier || 2} 🎁`;
        } else if (c && c.type === 'regalo') {
            const amt = parseFloat(cfg.gift_amount) || 0;
            headline = `Hoy, con tu compra, te regalamos L.${Number.isInteger(amt) ? amt : amt.toFixed(2)} de Rico Cash 🎁`;
        } else if (c && c.type === 'compra_x_lleva') {
            const names = {};
            for (const key of ['buy_item_id', 'get_item_id']) {
                const { data: it } = await supabase.from('menu_items')
                    .select('name').eq('id', cfg[key]).maybeSingle();
                names[key] = it && it.name ? it.name : 'tu favorito';
            }
            const pct = parseFloat(cfg.get_discount_pct != null ? cfg.get_discount_pct : 100);
            headline = `Hoy comprás ${names.buy_item_id} y te llevás ${names.get_item_id} ${pct >= 100 ? 'GRATIS' : 'con descuento'} 🎁`;
        }
        if (!headline) headline = c && c.name ? `Hoy: ${c.name} 🎁` : 'Hoy hay un especial del día 🎁';
    }
    if (!headline) headline = 'Hoy hay un especial del día 🎁';
    return {
        headline,
        terms: `Solo hoy · ${fmtEspecialTime(special.starts_time)} a ${fmtEspecialTime(special.ends_time)} · hasta agotar`,
        hint: 'Pedí normal y se aplica solo — o escribí ESPECIAL por WhatsApp y te lo guardamos.',
        starts_time: special.starts_time,
        ends_time: special.ends_time
    };
}

async function publicEspecial(restaurantId) {
    try {
        const st = await ricoLoyalty.getSpecialState(supabase, { restaurantId });
        if (!st || !st.special || st.phase !== 'active' || st.exhausted) return null;
        return await buildPublicEspecial(st.special);
    } catch (e) {
        console.error('[V2-Menu] especial lookup failed (menu unaffected):', e && e.message);
        return null;
    }
}

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
                is_house_made: item.is_house_made || false,
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

        // Especial del Día (display only): null unless one is set,
        // active and inside its hours today. See publicEspecial().
        const especial = await publicEspecial(finalResId);

        return res.json({ 
            items: finalItems, categories, expiringPrizes, modGroups: filteredGroups, 
            modOptions: rModOptions.data || [], itemModGroups: allItemMods, 
            bundleSlots, taxRate: 0,
            acceptedPayments: settings.accepted_payments || {},
            bankDetails: settings.bank_details || {},
            especial
        });

    } catch (e) {
        console.error("[V2-Menu] Error:", e);
        res.status(500).json({ error: "Internal Server Error" });
    }
};
