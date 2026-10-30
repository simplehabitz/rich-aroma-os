// api/lib/mission-unlock.js — Misiones del Capitán unlock helper,
// shared (loyalty build, 2026-10-30).
//
// This is the same logic store.js carries inline (its copy stays — the
// two are behavior-identical; deduping store.js onto this module is a
// later refactor, deliberately NOT part of the loyalty build's patch
// surface). It exists as a module so api/lib/order-service.js can run
// the one-line unlock for orders BORN 'paid' inside createOrder — the
// gap flagged when missions shipped: orders created already-paid by
// the orders-v2 engine never passed through the store.js status paths
// that call the inline copy.
//
// OWNER RULE: gift money never unlocks a mission. A mission unlocks
// only when its trigger item was paid with REAL money — cash, card,
// transfer, or the customer's own topped-up Rico balance. The split is
// read from the order: items[].rico_bonus_used first, else
// orders.rico_bonus_used — both populated by the two-bucket spend
// engine (api/lib/rico-loyalty.js). Absent field = 0 = eligible.
//
// This helper NEVER throws: a mission bug must not break an order.

function missionBonusAppliedToItem(order, itemId) {
    if (!order) return 0;
    const items = Array.isArray(order.items) ? order.items : [];
    const line = items.find(i => i && (i.id || i.item_id) === itemId);
    if (line && line.rico_bonus_used !== undefined && line.rico_bonus_used !== null) {
        return parseFloat(line.rico_bonus_used) || 0;
    }
    if (order.rico_bonus_used !== undefined && order.rico_bonus_used !== null) {
        return parseFloat(order.rico_bonus_used) || 0;
    }
    return 0;
}

async function unlockMissionsForOrder(order, supabase) {
    try {
        if (!supabase || !order || order.status !== 'paid' || !order.customer_id) return 0;
        const itemIds = [...new Set((Array.isArray(order.items) ? order.items : [])
            .map(i => i && (i.id || i.item_id)).filter(Boolean))];
        if (!itemIds.length) return 0;
        const today = new Date().toISOString().slice(0, 10);
        const { data: missions, error: mErr } = await supabase.from('missions')
            .select('*').eq('is_active', true).in('trigger_item_id', itemIds);
        if (mErr) { console.error('[Missions] mission lookup failed:', mErr.message); return 0; }
        let unlocked = 0;
        for (const m of (missions || [])) {
            try {
                if (m.active_from && today < String(m.active_from).slice(0, 10)) continue;
                if (m.active_to && today > String(m.active_to).slice(0, 10)) continue;
                // Gift money never unlocks (owner rule, above).
                if (missionBonusAppliedToItem(order, m.trigger_item_id) > 0) continue;
                const { data: mineAll } = await supabase.from('mission_assignments')
                    .select('id, status, expires_at').eq('mission_id', m.id).eq('customer_id', order.customer_id);
                const mine = mineAll || [];
                const nowMs = Date.now();
                let hasOpen = false;
                let approvedCount = 0;
                for (const a of mine) {
                    if (a.status === 'approved') { approvedCount++; continue; }
                    if (a.status === 'submitted') { hasOpen = true; continue; }
                    if (a.status === 'unlocked') {
                        if (a.expires_at && new Date(a.expires_at).getTime() <= nowMs) {
                            await supabase.from('mission_assignments')
                                .update({ status: 'expired' }).eq('id', a.id).eq('status', 'unlocked');
                        } else { hasOpen = true; }
                    }
                }
                if (hasOpen) continue;
                const maxCompletions = Math.max(1, parseInt(m.max_completions_per_customer) || 1);
                if (approvedCount >= maxCompletions) continue;
                if (m.cap_total) {
                    const { data: all } = await supabase.from('mission_assignments')
                        .select('id').eq('mission_id', m.id);
                    if ((all || []).length >= m.cap_total) continue;
                }
                const now = new Date();
                const expires = new Date(now.getTime() + (parseInt(m.deadline_hours) || 48) * 3600 * 1000);
                const { error } = await supabase.from('mission_assignments').insert({
                    id: 'masn_' + Date.now() + Math.floor(Math.random() * 100000),
                    mission_id: m.id,
                    customer_id: order.customer_id,
                    order_id: order.id,
                    status: 'unlocked',
                    unlocked_at: now.toISOString(),
                    expires_at: expires.toISOString()
                });
                if (!error) unlocked++;
            } catch (e) { /* one bad mission must not stop the others */ }
        }
        return unlocked;
    } catch (e) {
        console.error('[Missions] unlock failed (order unaffected):', e && e.message);
        return 0;
    }
}

module.exports = { unlockMissionsForOrder, missionBonusAppliedToItem };
