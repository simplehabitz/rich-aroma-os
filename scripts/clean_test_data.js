// scripts/clean_test_data.js
const { supabase } = require('../api/lib/supabase');

const PRODUCTION_RESTAURANTS = [
    'rich-aroma',
    'fradas-bar--grill-445',
    'dental-arita',
    'tonys-pizza',
    'pupuseria-mary'
];

async function cleanTestData() {
    console.log("🧹 Starting Safe Test Data Cleanup for QuimiEats...");

    // 1. Identify Test Restaurants
    const { data: allRes, error: resErr } = await supabase.from('restaurants').select('id, name');
    if (resErr) throw resErr;

    const testRestaurants = (allRes || [])
        .filter(r => !PRODUCTION_RESTAURANTS.includes(r.id))
        .map(r => r.id);

    console.log(`Found ${testRestaurants.length} test restaurants to clean up:`, testRestaurants);

    if (testRestaurants.length > 0) {
        // A. Delete Test Menu Items
        const { count: deletedItems, error: itemErr } = await supabase.from('menu_items')
            .delete({ count: 'exact' })
            .in('restaurant_id', testRestaurants);
        if (itemErr) console.error("Error deleting test menu items:", itemErr.message);
        else console.log(`✔ Deleted ${deletedItems || 0} test menu items.`);

        // B. Delete Test Loyalty Cards
        const { count: deletedLoyalty, error: loyErr } = await supabase.from('restaurant_loyalty_cards')
            .delete({ count: 'exact' })
            .in('restaurant_id', testRestaurants);
        if (loyErr) console.error("Error deleting test loyalty cards:", loyErr.message);
        else console.log(`✔ Deleted ${deletedLoyalty || 0} test loyalty cards.`);

        // C. Delete Test Ledger Entries
        const { count: deletedLedger, error: ledgErr } = await supabase.from('quimieats_ledger')
            .delete({ count: 'exact' })
            .in('restaurant_id', testRestaurants);
        if (ledgErr) console.error("Error deleting test ledger rows:", ledgErr.message);
        else console.log(`✔ Deleted ${deletedLedger || 0} test ledger entries.`);

        // D. Delete Test Orders
        const { count: deletedOrders, error: ordErr } = await supabase.from('orders')
            .delete({ count: 'exact' })
            .in('restaurant_id', testRestaurants);
        if (ordErr) console.error("Error deleting test orders:", ordErr.message);
        else console.log(`✔ Deleted ${deletedOrders || 0} test orders.`);

        // E. Delete Test Restaurants
        const { count: deletedResCount, error: delResErr } = await supabase.from('restaurants')
            .delete({ count: 'exact' })
            .in('id', testRestaurants);
        if (delResErr) console.error("Error deleting test restaurants:", delResErr.message);
        else console.log(`✔ Deleted ${deletedResCount || 0} test restaurants.`);
    }

    // 2. Delete Test Drivers / Employees
    const { data: testDrivers } = await supabase.from('employees')
        .select('id')
        .or('id.like.driver_carlos_%,id.like.driver_mario_%,id.like.driver_elena_%');

    const driverIds = (testDrivers || []).map(d => d.id);
    if (driverIds.length > 0) {
        const { count: delDrivers } = await supabase.from('employees')
            .delete({ count: 'exact' })
            .in('id', driverIds);
        console.log(`✔ Deleted ${delDrivers || 0} test drivers from employees.`);
    }

    // 3. Delete Test Customers
    const { data: testCusts } = await supabase.from('customers')
        .select('id')
        .or('id.like.cust_sofia_%,id.like.cust_carmen_%,name.eq.Sofia Rodriguez,name.eq.Carmen Rodriguez');

    const custIds = (testCusts || []).map(c => c.id);
    if (custIds.length > 0) {
        const { count: delCusts } = await supabase.from('customers')
            .delete({ count: 'exact' })
            .in('id', custIds);
        console.log(`✔ Deleted ${delCusts || 0} test customers.`);
    }

    // 4. Delete Simulation Ledger Entries attached to rich-aroma / quimieats-logistics
    const { count: delSimLedger } = await supabase.from('quimieats_ledger')
        .delete({ count: 'exact' })
        .in('order_id', [
            'hub_reimburse_ra_pm',
            'cashout_mario_pm',
            'hub_reimburse_ra',
            'driver_cashout_ra',
            'remittance_cashout_8821',
            'remittance_meal_purchase'
        ]);
    console.log(`✔ Deleted ${delSimLedger || 0} temporary simulation ledger entries.`);

    // 5. Verify Clean Production State
    const { data: finalRes } = await supabase.from('restaurants').select('id, name');
    console.log("\n✨ Database successfully cleaned! Remaining production restaurants:");
    (finalRes || []).forEach(r => console.log(`  🏢 ${r.id.padEnd(25)} -> ${r.name}`));
}

cleanTestData().catch(err => {
    console.error("Cleanup failed:", err);
    process.exit(1);
});
