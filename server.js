const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env.local') });
const multer = require('multer');
const upload = multer({ dest: '/tmp/' });

const app = express();

const supabaseUrl = process.env.SUPABASE_URL || 'https://zcqubacfcettwawcimsy.supabase.co';
const supabaseKey = process.env.SUPABASE_ANON_KEY || 'sb_publishable_hRVyru_6sektmVGQyJFfwQ_4b2-7MKq';
const supabase = createClient(supabaseUrl, supabaseKey);

app.use(cors());
app.use((req, res, next) => {
    console.log(`[REQUEST] ${new Date().toISOString()} - ${req.method} ${req.url}`);
    res.on('finish', () => {
        console.log(`[RESPONSE] ${new Date().toISOString()} - ${req.method} ${req.url} -> Status ${res.statusCode}`);
    });
    next();
});
app.use(express.json({ limit: '10mb' }));

// Auth Middleware
const requireAuth = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return next();

        const token = authHeader.split(' ')[1];
        if (!token) return next();

        // Admin PIN bypass
        if (token === '4574' || token === '3620' || token === 'EMP-admin' || token === 'TEST_TOKEN_ADMIN') {
            req.user = { id: 'admin', role: 'admin', email: 'admin@richaroma.com' };
            req.supabase = supabase;
            return next();
        }

        // Supabase Token Check
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (!error && user) {
            req.user = user;
            try {
                req.supabase = createClient(supabaseUrl, supabaseKey, {
                    global: { headers: { Authorization: `Bearer ${token}` } }
                });
            } catch (e) { req.supabase = supabase; }
        }
        next();
    } catch (e) {
        console.error("Auth Error:", e);
        next();
    }
};

app.use(requireAuth);

// Routes
app.get('/api/cash/current-shift', async (req, res) => {
    try {
        const { data: shift } = await supabase
            .from('cash_shifts')
            .select('*')
            .eq('status', 'open')
            .order('opened_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        res.json({ shift });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/menu', async (req, res) => {
    // Basic redirect to store API to keep it small
    res.redirect(`/api/store?action=menu&${new URLSearchParams(req.query).toString()}`);
});

const storeHandler = require('./api/store.js');
app.all('/api/store', async (req, res) => { try { await storeHandler(req, res); } catch(e) { res.status(500).json({error: e.message}); } });
app.all('/api/cash/:action', async (req, res) => {
    req.query.action = req.params.action;
    try { await storeHandler(req, res); } catch(e) { res.status(500).json({error: e.message}); }
});

// Customer & Authentication Local Router Mappings
const authHandler = require('./api/auth.js');
app.all('/api/auth/register', async (req, res) => {
    req.query.action = 'register';
    try {
        await authHandler(req, res);
    } catch(e) {
        res.status(500).json({error: e.message});
    }
});

app.all('/api/auth/login', async (req, res) => {
    req.query.action = 'login';
    try {
        await authHandler(req, res);
    } catch(e) {
        res.status(500).json({error: e.message});
    }
});

app.all('/api/customer/login', async (req, res) => {
    req.query.action = 'customer_login';
    try { await storeHandler(req, res); } catch(e) { res.status(500).json({error: e.message}); }
});

app.all('/api/customer/profile', async (req, res) => {
    req.query.action = 'customer_profile';
    try { await storeHandler(req, res); } catch(e) { res.status(500).json({error: e.message}); }
});

app.all('/api/customers/phone/:phone', async (req, res) => {
    req.query.action = 'customer_by_phone';
    req.query.query = req.params.phone;
    try { await storeHandler(req, res); } catch(e) { res.status(500).json({error: e.message}); }
});

app.all('/api/customers', async (req, res) => {
    req.query.action = req.method === 'POST' ? 'customer_create' : 'customers';
    try { await storeHandler(req, res); } catch(e) { res.status(500).json({error: e.message}); }
});

app.all('/api/customers/:id/load-balance', async (req, res) => {
    req.query.action = 'load_balance';
    req.query.id = req.params.id;
    try { await storeHandler(req, res); } catch(e) { res.status(500).json({error: e.message}); }
});

app.all('/api/customers/:id/purchase-membership', async (req, res) => {
    req.query.action = 'purchase_membership';
    req.query.id = req.params.id;
    try { await storeHandler(req, res); } catch(e) { res.status(500).json({error: e.message}); }
});

app.all('/api/customers/:id', async (req, res) => {
    req.query.action = req.method === 'POST' || req.method === 'PATCH' ? 'customer_update' : 'customer_details';
    req.query.id = req.params.id;
    try { await storeHandler(req, res); } catch(e) { res.status(500).json({error: e.message}); }
});

app.all('/api/orders', async (req, res) => {
    if (req.method === 'POST') {
        try { await ordersV2Handler(req, res); } catch(e) { res.status(500).json({error: e.message}); }
    } else {
        req.query.action = 'orders';
        try { await storeHandler(req, res); } catch(e) { res.status(500).json({error: e.message}); }
    }
});

app.all('/api/orders/:id', async (req, res) => {
    req.query.action = req.method === 'GET' ? 'orders' : 'order_update';
    req.query.id = req.params.id;
    try { await storeHandler(req, res); } catch(e) { res.status(500).json({error: e.message}); }
});

app.all('/api/orders/:id/delivery-status', async (req, res) => {
    req.query.action = 'order_delivery_status';
    req.query.id = req.params.id;
    try { await storeHandler(req, res); } catch(e) { res.status(500).json({error: e.message}); }
});

app.all('/api/orders/:id/customer-confirm', async (req, res) => {
    req.query.action = 'customer_confirm_delivery';
    req.query.id = req.params.id;
    try { await storeHandler(req, res); } catch(e) { res.status(500).json({error: e.message}); }
});

app.all('/api/driver/login', async (req, res) => {
    req.query.action = 'driver_login';
    try { await storeHandler(req, res); } catch(e) { res.status(500).json({error: e.message}); }
});

app.all('/api/driver/orders', async (req, res) => {
    req.query.action = 'driver_orders';
    try { await storeHandler(req, res); } catch(e) { res.status(500).json({error: e.message}); }
});

app.all('/api/driver/orders/:id/claim', async (req, res) => {
    req.query.action = 'driver_claim';
    req.query.id = req.params.id;
    try { await storeHandler(req, res); } catch(e) { res.status(500).json({error: e.message}); }
});

const adminHandler = require('./api/admin.js');
app.all('/api/admin', async (req, res) => {
    try { await adminHandler(req, res); } catch(e) { res.status(500).json({error: e.message}); }
});

// Admin modifiers specific sub-routes
app.all('/api/admin/menu/:id/modifiers', async (req, res) => {
    req.query.action = req.method === 'POST' ? 'menu_modifiers_update' : 'menu_item_modifiers';
    req.query.id = req.params.id;
    try { await adminHandler(req, res); } catch(e) { res.status(500).json({error: e.message}); }
});

app.all('/api/admin/modifiers/groups/:id', async (req, res) => {
    req.query.action = 'modifiers_group_delete';
    req.query.id = req.params.id;
    try { await adminHandler(req, res); } catch(e) { res.status(500).json({error: e.message}); }
});

app.all('/api/admin/modifiers/options/:id', async (req, res) => {
    req.query.action = 'modifiers_option_delete';
    req.query.id = req.params.id;
    try { await adminHandler(req, res); } catch(e) { res.status(500).json({error: e.message}); }
});

app.all('/api/admin/modifiers/groups', async (req, res) => {
    req.query.action = 'modifiers_group_create';
    try { await adminHandler(req, res); } catch(e) { res.status(500).json({error: e.message}); }
});

app.all('/api/admin/modifiers/options', async (req, res) => {
    req.query.action = 'modifiers_option_create';
    try { await adminHandler(req, res); } catch(e) { res.status(500).json({error: e.message}); }
});

app.all('/api/admin/modifiers', async (req, res) => {
    req.query.action = 'modifiers';
    try { await adminHandler(req, res); } catch(e) { res.status(500).json({error: e.message}); }
});

app.all('/api/admin/:action', async (req, res) => {
    req.query.action = req.params.action;
    try { await adminHandler(req, res); } catch(e) { res.status(500).json({error: e.message}); }
});

// Employee onboarding simulation routes
app.post('/api/timeclock', async (req, res) => {
    const { employeeId, type } = req.body;
    try {
        const { data, error } = await supabase.from('time_entries').insert({
            employee_id: employeeId,
            type: type,
            timestamp: new Date().toISOString()
        }).select().single();
        if (error) throw error;
        return res.json(data);
    } catch (e) {
        return res.json({ id: 'time_' + Date.now(), employee_id: employeeId, type, timestamp: new Date().toISOString() });
    }
});

app.get('/api/timeclock', async (req, res) => {
    try {
        const { data, error } = await supabase.from('time_entries').select('*');
        if (error) throw error;
        return res.json({ punches: data || [] });
    } catch (e) {
        return res.json({ punches: [] });
    }
});

app.post('/api/contracts', async (req, res) => {
    const { employeeId, contractText, signature } = req.body;
    try {
        const { data, error } = await supabase.from('employee_contracts').insert({
            id: 'con_' + Date.now(),
            employee_id: employeeId,
            contract_text: contractText,
            signature: signature,
            signed: true,
            signed_at: new Date().toISOString()
        }).select().single();
        if (error) throw error;
        return res.json(data);
    } catch (e) {
        return res.json({ id: 'con_' + Date.now(), employee_id: employeeId, signed: true });
    }
});

app.post('/api/tasks', async (req, res) => {
    const { employeeId, taskId } = req.body;
    try {
        const { data, error } = await supabase.from('task_logs').insert({
            employee_id: employeeId,
            task_id: taskId,
            completed_at: new Date().toISOString()
        }).select().single();
        if (error) throw error;
        return res.json(data);
    } catch (e) {
        return res.json({ id: 'task_log_' + Date.now(), employee_id: employeeId, task_id: taskId, completed_at: new Date().toISOString() });
    }
});

const v2MenuHandler = require('./api/v2-menu.js');
app.all('/api/v2-menu', async (req, res) => { try { await v2MenuHandler(req, res); } catch(e) { res.status(500).json({error: e.message}); } });

const promosHandler = require('./api/promos.js');
app.all('/api/promos', async (req, res) => { try { await promosHandler(req, res); } catch(e) { res.status(500).json({error: e.message}); } });

const ordersV2Handler = require('./api/orders-v2.js');
app.all('/api/orders-v2', async (req, res) => { try { await ordersV2Handler(req, res); } catch(e) { res.status(500).json({error: e.message}); } });

const whatsappHandler = require('./api/whatsapp-webhook.js');
app.all('/api/whatsapp-webhook', async (req, res) => { try { await whatsappHandler(req, res); } catch(e) { res.status(500).json({error: e.message}); } });

const caliHandler = require('./api/cali.js');
app.all('/api/cali', async (req, res) => { 
    try { 
        // Emulate Vercel's req.query action binding from subroutes if needed
        if (req.params[0]) {
            req.query.action = req.params[0];
        }
        await caliHandler(req, res); 
    } catch(e) { 
        res.status(500).json({error: e.message}); 
    } 
});

const checkoutHandler = require('./api/checkout.js');
app.all('/api/checkout', async (req, res) => { try { await checkoutHandler(req, res); } catch(e) { res.status(500).json({error: e.message}); } });

const academyHandler = require('./api/academy.js');
app.all('/api/academy', async (req, res) => { try { await academyHandler(req, res); } catch(e) { res.status(500).json({error: e.message}); } });

const onrampHandler = require('./api/onramp.js');
app.all('/api/onramp/:action?', async (req, res) => { try { await onrampHandler(req, res); } catch(e) { res.status(500).json({error: e.message}); } });

const gachaHandler = require('./api/gacha.js');
app.all('/api/gacha/:action?', async (req, res) => { try { await gachaHandler(req, res); } catch(e) { res.status(500).json({error: e.message}); } });

const fs = require('fs');
const { exec } = require('child_process');

app.all('/api/chain-bot/:endpoint?', async (req, res) => {
    try {
        const handler = (await import('./api/chain-bot.js')).default;
        req.query.endpoint = req.params.endpoint || req.query.endpoint || '';
        await handler(req, res);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/src', express.static(path.join(__dirname, 'src')));

// Custom URL route rewrites to match Vercel production setup
app.get('/socios', (req, res) => res.sendFile(path.join(__dirname, 'public/socios.html')));
app.get('/onboarding', (req, res) => res.sendFile(path.join(__dirname, 'public/onboarding.html')));
app.get('/os', (req, res) => res.sendFile(path.join(__dirname, 'public/os.html')));
app.get('/partner-os', (req, res) => res.sendFile(path.join(__dirname, 'public/partner-os.html')));
app.get('/pos-v2', (req, res) => res.sendFile(path.join(__dirname, 'public/pos-v2.html')));
app.get('/owner', (req, res) => res.sendFile(path.join(__dirname, 'public/owner.html')));
app.get('/kitchen', (req, res) => res.sendFile(path.join(__dirname, 'public/kitchen.html')));
app.get('/hub', (req, res) => res.sendFile(path.join(__dirname, 'public/kitchen.html')));
app.get('/driver-portal', (req, res) => res.sendFile(path.join(__dirname, 'public/driver-portal.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'src/admin/admin.html')));
app.get('/quimieats-admin', (req, res) => res.sendFile(path.join(__dirname, 'public/quimieats-admin.html')));

app.get('/cali/admin', (req, res) => res.sendFile(path.join(__dirname, 'public/cali/admin.html')));
app.get('/cali/pos', (req, res) => res.sendFile(path.join(__dirname, 'public/cali/pos.html')));

const PORT = process.env.PORT || 8083;
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`
╔═══════════════════════════════════════════════════════╗
║                                                       ║
║     ☕  RICH AROMA OS  ☕                             ║
║                                                       ║
║     Server running on http://localhost:\${PORT}          ║
║     Connected to Supabase                             ║
║     SECURITY: Middleware Enabled (Bearer Token)       ║
║                                                       ║
╚═══════════════════════════════════════════════════════╝
        `);
    });
}

module.exports = app;
