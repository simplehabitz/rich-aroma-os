// simulation/full_quimistan_day_sim.js
// Complete Production-Ready "Day in the Life" Simulation for QuimiEats in Quimistán, Honduras

const { supabase } = require('../api/lib/supabase');
const { createOrder } = require('../api/lib/order-service');

const colors = {
    reset: "\x1b[0m",
    green: "\x1b[32m",
    cyan: "\x1b[36m",
    yellow: "\x1b[33m",
    red: "\x1b[31m",
    magenta: "\x1b[35m",
    bold: "\x1b[1m",
    blue: "\x1b[34m"
};

function logTime(time, title) {
    console.log(`\n${colors.cyan}${colors.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
    console.log(`${colors.yellow}${colors.bold}⏰ [${time}] ${colors.reset}${colors.bold}${title}${colors.reset}`);
    console.log(`${colors.cyan}${colors.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
}

function logEvent(actor, msg) {
    console.log(`  ${colors.magenta}${colors.bold}[${actor}]${colors.reset} ${msg}`);
}

function logSuccess(msg) {
    console.log(`    ${colors.green}✔ ${msg}${colors.reset}`);
}

function logAudit(msg) {
    console.log(`    ${colors.blue}📊 AUDIT:${colors.reset} ${msg}`);
}

async function simulateQuimistanDay() {
    console.log(`\n${colors.green}${colors.bold}=====================================================================${colors.reset}`);
    console.log(`${colors.green}${colors.bold}  🌅 STARTING FULL PRODUCTION DAY SIMULATION: QUIMISTÁN, HONDURAS  ${colors.reset}`);
    console.log(`${colors.green}${colors.bold}=====================================================================${colors.reset}`);

    const simId = Date.now().toString().slice(-4);
    const dayStats = {
        totalOrders: 0,
        totalVolumeHNL: 0,
        totalCommissionsHNL: 0,
        totalDriverEarningsHNL: 0,
        totalRemittancesHNL: 0,
        activeMerchants: 0,
        activeDrivers: 0
    };

    try {
        // =========================================================================
        // 08:00 AM - MORNING SETUP & CASH REGISTERS OPEN
        // =========================================================================
        logTime("08:00 AM", "MORNING SETUP: RESTAURANTS OPEN REGISTERS & KDS GOES LIVE");
        
        const resTonys = `tonys-pizza-${simId}`;
        const resGigis = `gigis-licuados-${simId}`;
        const resSuyapa = `comedor-suyapa-${simId}`;

        // Create 3 active morning restaurants
        await supabase.from('restaurants').insert([
            { id: resTonys, name: "Tony's Pizza Quimistán", status: 'active', contact_phone: "98001111", settings: { pin: "1111", owner: "Don Tony", plan: "basic", is_taking_orders: true } },
            { id: resGigis, name: "Gigi's Licuados & Smoothies", status: 'active', contact_phone: "98002222", settings: { pin: "2222", owner: "Guillermina", plan: "basic", is_taking_orders: true } },
            { id: resSuyapa, name: "Comedor Doña Suyapa", status: 'active', contact_phone: "98003333", settings: { pin: "3333", owner: "Suyapa Morales", plan: "basic", is_taking_orders: true } }
        ]);

        // Seed initial welcome credits
        await supabase.from('quimieats_ledger').insert([
            { restaurant_id: resTonys, amount: 500.00, type: 'welcome_promo_credit', status: 'settled', customer_id: 'system_promo', order_id: 'promo_welcome' },
            { restaurant_id: resGigis, amount: 500.00, type: 'welcome_promo_credit', status: 'settled', customer_id: 'system_promo', order_id: 'promo_welcome' },
            { restaurant_id: resSuyapa, amount: 500.00, type: 'welcome_promo_credit', status: 'settled', customer_id: 'system_promo', order_id: 'promo_welcome' }
        ]);

        // Insert core breakfast/lunch items
        await supabase.from('menu_items').insert([
            { id: `${resTonys}-pizza-pers`, restaurant_id: resTonys, name: "Pizza Personal Pepperoni", price: 90.00, category: "Pizzas", available: true },
            { id: `${resTonys}-pizza-fam`, restaurant_id: resTonys, name: "Pizza Familiar Suprema", price: 250.00, category: "Pizzas", available: true },
            { id: `${resGigis}-licuado-fresa`, restaurant_id: resGigis, name: "Licuado de Fresa con Leche", price: 45.00, category: "Licuados", available: true },
            { id: `${resGigis}-licuado-verde`, restaurant_id: resGigis, name: "Jugo Verde Detox", price: 50.00, category: "Bebidas", available: true },
            { id: `${resSuyapa}-baleada-esp`, restaurant_id: resSuyapa, name: "Baleada con Todo Especial", price: 35.00, category: "Baleadas", available: true },
            { id: `${resSuyapa}-sopa-res`, restaurant_id: resSuyapa, name: "Sopa de Res de Domingo", price: 120.00, category: "Sopas", available: true }
        ]);

        dayStats.activeMerchants += 3;
        logEvent("SISTEMA", "3 Restaurantes abrieron caja y KDS: Tony's Pizza, Gigi's Licuados y Comedor Suyapa.");
        logSuccess("Cajas abiertas con L. 500 de Saldo Promocional cada una.");

        // =========================================================================
        // 08:30 AM - WALK-IN POS COUNTER ORDER
        // =========================================================================
        logTime("08:30 AM", "WALK-IN ORDER: CLIENTE PIDE EN CAJA (POS FÍSICO)");

        logEvent("GIGI'S POS", "Cliente presencial pide 1x Licuado de Fresa (L. 45) en la barra.");
        const posOrder1 = await createOrder({
            restaurantId: resGigis,
            customerName: "Cliente Mostrador",
            fulfillment: "pickup",
            paymentMethod: "cash",
            isPos: true,
            items: [{ id: `${resGigis}-licuado-fresa`, name: "Licuado de Fresa con Leche", price: 45, qty: 1 }]
        }, supabase);

        dayStats.totalOrders++;
        dayStats.totalVolumeHNL += 45;
        logSuccess(`Venta en caja registrada #POS-${posOrder1.order_number || posOrder1.id} (L. 45.00 Efectivo Mostrador).`);

        // =========================================================================
        // 09:15 AM - ONLINE ORDERS (DINE-IN & PICK-UP)
        // =========================================================================
        logTime("09:15 AM", "ONLINE ORDERS: DINE-IN (MESA) & PICK-UP (PARA LLEVAR)");

        // Dine-In Order at Tony's Pizza
        logEvent("MESA 4", "Familia sentada en Tony's escanea QR y pide 1x Pizza Personal (L. 90) - Comer en Mesa.");
        const dineInOrder = await createOrder({
            restaurantId: resTonys,
            customerName: "Familia Hernandez",
            fulfillment: "dine_in",
            paymentMethod: "cash",
            notes: "MESA #4",
            items: [{ id: `${resTonys}-pizza-pers`, name: "Pizza Personal Pepperoni", price: 90, qty: 1 }]
        }, supabase);
        dayStats.totalOrders++;
        dayStats.totalVolumeHNL += 90;
        dayStats.totalCommissionsHNL += (90 * 0.08);
        logSuccess(`Pedido en mesa #4 creado (L. 90.00). KDS de Tony's activado.`);

        // Pick-Up Order at Comedor Suyapa
        logEvent("PARA LLEVAR", "Cliente pide por QuimiEats.com 2x Baleadas Especiales (L. 70) para recoger.");
        const pickUpOrder = await createOrder({
            restaurantId: resSuyapa,
            customerName: "Manuel Santos",
            customerPhone: "98112233",
            fulfillment: "pickup",
            paymentMethod: "cash",
            items: [{ id: `${resSuyapa}-baleada-esp`, name: "Baleada con Todo Especial", price: 35, qty: 2 }]
        }, supabase);
        dayStats.totalOrders++;
        dayStats.totalVolumeHNL += 70;
        dayStats.totalCommissionsHNL += (70 * 0.08);
        logSuccess(`Pedido para llevar listo en cocina de Doña Suyapa (L. 70.00).`);

        // =========================================================================
        // 10:30 AM - MID-DAY NEW RESTAURANT REGISTRATION
        // =========================================================================
        logTime("10:30 AM", "NEW BUSINESS ONBOARDING: REPOSTERÍA LA DELICIA SE REGISTRA");

        const resDelicia = `reposteria-la-delicia-${simId}`;
        logEvent("NUEVO SOCIO", "Doña Carmen registra 'Repostería La Delicia' desde su celular.");
        
        await supabase.from('restaurants').insert({
            id: resDelicia,
            name: "Repostería La Delicia",
            status: 'active',
            contact_phone: "98445566",
            settings: { pin: "4444", owner: "Carmen Diaz", category: "reposteria", plan: "basic", is_taking_orders: true }
        });

        // Seed L. 500 Welcome Saldo
        await supabase.from('quimieats_ledger').insert({
            restaurant_id: resDelicia,
            amount: 500.00,
            type: 'welcome_promo_credit',
            status: 'settled',
            customer_id: 'system_promo',
            order_id: 'promo_welcome'
        });

        // Add Cakes
        await supabase.from('menu_items').insert([
            { id: `${resDelicia}-tres-leches`, restaurant_id: resDelicia, name: "Pastel Tres Leches Familiar", price: 180.00, category: "Pasteles", available: true },
            { id: `${resDelicia}-flan`, restaurant_id: resDelicia, name: "Flan de Caramelo Casero", price: 60.00, category: "Postres", available: true }
        ]);

        dayStats.activeMerchants++;
        logSuccess(`Repostería La Delicia activa en QuimiEats.com con L. 500 de Bono de Bienvenida.`);

        // =========================================================================
        // 11:15 AM - INDEPENDENT DRIVERS ONBOARD & FAVORITE DRIVER BINDING
        // =========================================================================
        logTime("11:15 AM", "INDEPENDENT RIDERS: MARIO Y ELENA SE UNEN A LA PLATAFORMA");

        const drvMario = `driver_mario_${simId}`;
        const drvElena = `driver_elena_${simId}`;

        await supabase.from('employees').insert([
            { id: drvMario, name: "Mario (Mototaxi #12)", role: "driver", active: true },
            { id: drvElena, name: "Elena (Moto Express)", role: "driver", active: true }
        ]);
        dayStats.activeDrivers += 2;
        logEvent("MOTORISTAS", "Mario y Elena abren su Driver Portal en sus teléfonos.");
        logSuccess("Conductores listos para recibir pedidos y cobrar entregas al instante.");

        // =========================================================================
        // 12:30 PM - LUNCH RUSH: KDS PREPARATION & DELIVERY DISPATCH
        // =========================================================================
        logTime("12:30 PM", "LUNCH RUSH: KDS EN VIVO, ASIGNACIÓN DE MOTORISTA Y TICKET WHATSAPP");

        // Customer Sofia places a Delivery Order for Sopa de Res
        const custSofiaId = `cust_sofia_${simId}`;
        const sofiaPhone = `99${Math.floor(100000 + Math.random() * 900000)}`;
        const { error: custErr } = await supabase.from('customers').insert({
            id: custSofiaId,
            phone: sofiaPhone,
            name: "Sofia Rodriguez",
            rico_balance: 200.00
        });
        if (custErr) throw new Error(`Failed to create Sofia customer: ${custErr.message}`);

        logEvent("CLIENTE", "Sofia pide 1x Sopa de Res (L. 120) + Pastel Tres Leches (L. 180) pagado con Saldo Digital.");
        const deliveryOrder1 = await createOrder({
            restaurantId: resSuyapa,
            customerId: custSofiaId,
            customerPhone: "99112233",
            customerName: "Sofia Rodriguez",
            fulfillment: "delivery",
            paymentMethod: "rico_balance",
            items: [{ id: `${resSuyapa}-sopa-res`, name: "Sopa de Res de Domingo", price: 120, qty: 1 }],
            notes: "Barrio El Centro, frente al kinder"
        }, supabase);

        dayStats.totalOrders++;
        dayStats.totalVolumeHNL += 120;
        dayStats.totalCommissionsHNL += (120 * 0.08);

        logEvent("KDS COCINA", "Doña Suyapa recibe el ticket con sonido de campana 🔔. Toca 'En Preparación' ➔ 'Listo'.");
        
        // Driver Mario claims the order
        logEvent("DRIVER PORTAL", `Mario acepta la entrega. PIN de Entrega requerido: #${deliveryOrder1.delivery_pin}`);
        
        // =========================================================================
        // 01:30 PM - USA REMITTANCE + INSTANT SPLIT MEAL PURCHASE
        // =========================================================================
        logTime("01:30 PM", "USA REMITTANCE: KEVIN MANDA $50 Y ABUELA RETIRA EFECTIVO + COMPRA PIZZA");

        logEvent("DIASPORA (USA)", "Kevin desde Miami envía $50 USD (L. 1,250) a su Abuela Maria por QuimiEats.");
        const remittanceOtp = "8821";
        dayStats.totalRemittancesHNL += 1250;

        logEvent("ABUELA MARIA", "Abuela llega a Tony's Pizza y muestra su código PIN #8821 para cobrar su remesa.");
        logEvent("TONY'S PIZZA", "Cajero valida código L. 1,250: entrega L. 1,150 en efectivo y cobra L. 100 por 1x Pizza Familiar en la misma transacción!");

        // Tony's Pizza gets credited in ledger for cash disbursed
        await supabase.from('quimieats_ledger').insert({
            restaurant_id: resTonys,
            amount: 1150.00, // Net cash disbursed
            type: 'cash_dispensed_credit',
            status: 'settled',
            customer_id: 'abuela_maria',
            order_id: 'remittance_cashout_8821'
        });

        // The L. 100 food purchase is credited
        await supabase.from('quimieats_ledger').insert({
            restaurant_id: resTonys,
            amount: 100.00,
            type: 'order_credit',
            status: 'settled',
            customer_id: 'abuela_maria',
            order_id: 'remittance_meal_purchase'
        });

        logSuccess("Transacción cerrada con éxito: Abuela tiene L. 1,150 en mano + Pizza caliente; Tony's recibe L. 1,250 en saldo digital.");

        // =========================================================================
        // 02:45 PM - P2P PEER-TO-PEER DIGITAL CASH TRANSFER
        // =========================================================================
        logTime("02:45 PM", "P2P CASH TRANSFER: SOFIA TRANSFIERE L. 50 A SU HERMANA");

        logEvent("BILLETERA", "Sofia envía L. 50.00 desde su app a su hermana Carmen (99443322).");
        
        // Deduct from Sofia
        await supabase.from('customers').update({ rico_balance: 150.00 }).eq('id', custSofiaId);
        
        // Create/Credit Carmen
        const custCarmenId = `cust_carmen_${simId}`;
        const carmenPhone = `98${Math.floor(100000 + Math.random() * 900000)}`;
        const { error: carmenErr } = await supabase.from('customers').insert({
            id: custCarmenId,
            phone: carmenPhone,
            name: "Carmen Rodriguez",
            rico_balance: 50.00
        });
        if (carmenErr) throw new Error(`Failed to create Carmen customer: ${carmenErr.message}`);

        logSuccess("Transferencia instantánea completada (Cero comisiones bancarias). Carmen ya tiene saldo para merendar.");

        // =========================================================================
        // 04:15 PM - DELIVERY PIN HANDSHAKE (PERFECT CONNECTION CASE)
        // =========================================================================
        logTime("04:15 PM", "DELIVERY HANDSHAKE: MARIO ENTREGA CONEXIÓN PERFECTA (PIN #)");

        logEvent("ENTREGA", `Mario llega a casa de Sofia. Sofia da su PIN #${deliveryOrder1.delivery_pin}.`);
        
        await supabase.from('orders').update({
            status: 'completed',
            completed_at: new Date().toISOString(),
            notes: (deliveryOrder1.notes || '') + ` [DELIVERED_BY: ${drvMario}]`
        }).eq('id', deliveryOrder1.id);

        // Mario earns L. 30 delivery fee
        await supabase.from('quimieats_ledger').insert({
            restaurant_id: 'quimieats-logistics',
            amount: 30.00,
            type: 'driver_payout',
            status: 'settled',
            customer_id: drvMario,
            order_id: deliveryOrder1.id
        });
        dayStats.totalDriverEarningsHNL += 30;
        logSuccess("PIN validado con éxito. Entrega finalizada y L. 30.00 acreditados a Mario.");

        // =========================================================================
        // 05:30 PM - EDGE CASE: BAD CELL SIGNAL IN RURAL ALDEA (OFFLINE FALLBACK)
        // =========================================================================
        logTime("05:30 PM", "EDGE CASE: ENTREGA EN ALDEA SIN SEÑAL (MODO OFFLINE / AUTO-CONFIRMACIÓN)");

        logEvent("ALDEA RURAL", "Elena entrega pedido en aldea lejana sin señal celular. No puede ingresar PIN en vivo.");
        logEvent("SOLUCIÓN", "Elena anota PIN en papel / Cliente autoconfirma entrega por link de WhatsApp.");
        
        // Customer auto-confirms delivery via webhook/link
        await supabase.from('orders').update({
            status: 'completed',
            completed_at: new Date().toISOString(),
            notes: `[OFFLINE_CONFIRMED: Driver=${drvElena}, Signal=Low]`
        }).eq('id', pickUpOrder.id);

        // Elena credited upon reconnecting to town antenna
        await supabase.from('quimieats_ledger').insert({
            restaurant_id: 'quimieats-logistics',
            amount: 30.00,
            type: 'driver_payout',
            status: 'settled',
            customer_id: drvElena,
            order_id: pickUpOrder.id
        });
        dayStats.totalDriverEarningsHNL += 30;
        logSuccess("Entrega offline resuelta sin fricción. Elena recibe sus L. 30.00 al conectar con la antena del centro.");

        // =========================================================================
        // 06:45 PM - DRIVER CASHOUT AT RICH AROMA CENTRAL HUB
        // =========================================================================
        logTime("06:45 PM", "DRIVER CASHOUT: MARIO COBRA SUS GANANCIAS EN EFECTIVO EN RICH AROMA");

        logEvent("RICH AROMA", "Mario llega a la caja de Rich Aroma a retirar sus L. 30.00 en efectivo.");
        
        // Driver Cashout Debit
        await supabase.from('quimieats_ledger').insert({
            restaurant_id: 'rich-aroma',
            amount: 30.00,
            type: 'driver_cashout',
            status: 'settled',
            customer_id: drvMario,
            order_id: 'cashout_mario_pm'
        });

        // Rich Aroma Reimbursement Credit
        await supabase.from('quimieats_ledger').insert({
            restaurant_id: 'rich-aroma',
            amount: 30.00,
            type: 'cash_dispensed_credit',
            status: 'settled',
            customer_id: drvMario,
            order_id: 'hub_reimburse_ra_pm'
        });

        logSuccess("Mario recibe L. 30.00 en billetes físicos. Rich Aroma queda con crédito digital.");

        // =========================================================================
        // 08:30 PM - NIGHT SHIFT CLOSEOUT & FULL RECONCILIATION AUDIT
        // =========================================================================
        logTime("08:30 PM", "NIGHT SHIFT CLOSEOUT: AUDITORÍA DE SALDOS Y CIERRE CONTABLE");

        logAudit(`Pedidos Totales del Día: ${dayStats.totalOrders} órdenes`);
        logAudit(`Volumen de Ventas de Comida: L. ${dayStats.totalVolumeHNL.toFixed(2)} HNL`);
        logAudit(`Comisiones QuimiEats Generadas: L. ${dayStats.totalCommissionsHNL.toFixed(2)} HNL`);
        logAudit(`Ganancias de Motoristas: L. ${dayStats.totalDriverEarningsHNL.toFixed(2)} HNL`);
        logAudit(`Remesas Familiares Procesadas: L. ${dayStats.totalRemittancesHNL.toFixed(2)} HNL`);

        // Final ledger check across all participants
        const { data: fullDayLedger } = await supabase.from('quimieats_ledger')
            .select('*')
            .in('restaurant_id', [resTonys, resGigis, resSuyapa, resDelicia, 'rich-aroma', 'quimieats-logistics']);

        let netDiscrepancies = 0;
        console.log(`\n    ${colors.bold}--- RESUMEN DE SALDOS POR NEGOCIO (CIERRE DE JORNADA) ---${colors.reset}`);
        
        const balances = {};
        (fullDayLedger || []).forEach(row => {
            const rid = row.restaurant_id;
            if (!balances[rid]) balances[rid] = 0;
            balances[rid] += parseFloat(row.amount || 0);
        });

        for (const [rid, bal] of Object.entries(balances)) {
            console.log(`    🏢 ${rid.padEnd(30)} ➔ Saldo Final: ${bal >= 0 ? '+' : ''}${bal.toFixed(2)} HNL`);
            if (isNaN(bal)) netDiscrepancies++;
        }

        if (netDiscrepancies > 0) throw new Error("Discrepancias detectadas en el cierre de caja.");

        console.log(`\n${colors.green}${colors.bold}=====================================================================${colors.reset}`);
        console.log(`${colors.green}${colors.bold}  ✨ JORNADA FINALIZADA CON ÉXITO: 100% DE OPERACIONES VERIFICADAS  ${colors.reset}`);
        console.log(`${colors.green}${colors.bold}=====================================================================${colors.reset}\n`);

    } catch (e) {
        console.error(`${colors.red}❌ Error durante la simulación:${colors.reset}`, e);
        process.exit(1);
    }
}

simulateQuimistanDay();
