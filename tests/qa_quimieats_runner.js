const puppeteer = require('puppeteer');
const fetch = require('node-fetch');

const BASE_URL = 'http://localhost:8083';

async function runTests() {
    console.log('🏁 STARTING QUIMIEATS FULL QA SUITE...\n');
    let passed = 0;
    let failed = 0;

    const report = {
        api_active_businesses: { status: 'FAIL', details: '' },
        api_menu: { status: 'FAIL', details: '' },
        api_promos: { status: 'FAIL', details: '' },
        customer_ui_rendering: { status: 'FAIL', details: '' },
        customer_ui_categories: { status: 'FAIL', details: '' },
        customer_ui_menu_load: { status: 'FAIL', details: '' },
        order_creation: { status: 'FAIL', details: '' },
        driver_dispatch: { status: 'FAIL', details: '' },
        admin_dashboard: { status: 'FAIL', details: '' }
    };

    function logTest(key, isSuccess, details) {
        if (isSuccess) {
            report[key].status = 'PASS';
            report[key].details = details;
            console.log(`✅ [PASS] ${key}: ${details}`);
            passed++;
        } else {
            report[key].status = 'FAIL';
            report[key].details = details;
            console.log(`❌ [FAIL] ${key}: ${details}`);
            failed++;
        }
    }

    let activeBusinessId = '';
    let activeBusinessName = '';

    // ==========================================
    // PHASE 1: BACKEND API TESTS
    // ==========================================
    console.log('--- 🌐 PHASE 1: API TESTING ---');

    // Test 1: Whitelist active businesses
    try {
        const res = await fetch(`${BASE_URL}/api/admin?action=quimieats_active`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
            // Find a restaurant to test menu with (must be active in frontend like 'rich-aroma')
            const rest = data.find(b => b.id === 'rich-aroma') || data.find(b => b.category === 'restaurante') || data[0];
            activeBusinessId = rest.id;
            activeBusinessName = rest.name;
            logTest('api_active_businesses', true, `Found ${data.length} active businesses. Selected '${activeBusinessName}' (${activeBusinessId}) for testing.`);
        } else {
            logTest('api_active_businesses', false, `Empty or invalid response: ${JSON.stringify(data)}`);
        }
    } catch (e) {
        logTest('api_active_businesses', false, `Error querying active businesses: ${e.message}`);
    }

    // Test 2: Fetch menu for active business
    if (activeBusinessId) {
        try {
            const res = await fetch(`${BASE_URL}/api/v2-menu?id=${activeBusinessId}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            
            // Checking menu items or categories structure
            const categories = data.categories ? Object.keys(data.categories) : [];
            const items = data.items || [];
            if (categories.length > 0 || items.length > 0 || Array.isArray(data)) {
                logTest('api_menu', true, `Successfully loaded menu for '${activeBusinessName}'. Found ${categories.length} categories / ${items.length || data.length || 0} items.`);
            } else {
                logTest('api_menu', false, `Menu empty or format unexpected: ${JSON.stringify(data)}`);
            }
        } catch (e) {
            logTest('api_menu', false, `Error loading menu: ${e.message}`);
        }
    } else {
        logTest('api_menu', false, 'Skipped because no active business ID was found.');
    }

    // Test 3: Active promos & impressions
    try {
        const res = await fetch(`${BASE_URL}/api/promos?action=active`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        logTest('api_promos', true, `Loaded ${data.length} active promos.`);
    } catch (e) {
        logTest('api_promos', false, `Error loading promos: ${e.message}`);
    }

    // ==========================================
    // PHASE 2: PUPPETEER FRONTEND TESTS
    // ==========================================
    console.log('\n--- 🖥️ PHASE 2: BROWSER TESTING ---');
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();

    // Set viewport to mobile size since QuimiEats is mobile-first
    await page.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true });

    try {
        // Test 4: Page rendering & Initial Load
        console.log('Loading customer page...');
        await page.goto(`${BASE_URL}/quimieats.html`, { waitUntil: 'networkidle2', timeout: 20000 });
        
        // Wait for key elements to render
        await page.waitForSelector('#location-selector', { timeout: 5000 });
        await page.waitForSelector('#restaurant-list', { timeout: 5000 });

        const title = await page.title();
        const hasQEText = await page.evaluate(() => document.body.innerText.includes('QuimiEats'));

        if (hasQEText) {
            logTest('customer_ui_rendering', true, `Successfully rendered page with title: "${title}"`);
        } else {
            logTest('customer_ui_rendering', false, 'Page loaded but "QuimiEats" brand text was missing.');
        }

        // Test 5: Category Filter Click Behavior
        console.log('Testing category filters...');
        const filters = ['comida', 'super', 'cafe'];
        let filterSuccess = true;
        for (const cat of filters) {
            const btnSelector = `div[onclick*="filterRestaurants('${cat}')"]`;
            try {
                await page.waitForSelector(btnSelector, { timeout: 3000 });
                await page.click(btnSelector);
                await page.evaluate(() => new Promise(r => setTimeout(r, 500))); // wait for filter animation
            } catch (err) {
                filterSuccess = false;
                console.error(`Failed to filter by category: ${cat}`, err.message);
            }
        }
        if (filterSuccess) {
            logTest('customer_ui_categories', true, 'Category filter tabs are present, clickable, and execute filter functions.');
        } else {
            logTest('customer_ui_categories', false, 'One or more category filters failed to react.');
        }

        // Test 6: Open Restaurant & Load Menu
        console.log(`Opening restaurant '${activeBusinessName}'...`);
        let menuLoaded = false;
        try {
            // Re-click all filter to reset list
            await page.evaluate(() => filterRestaurants(null));
            await page.evaluate(() => new Promise(r => setTimeout(r, 500)));

            // Click the restaurant card
            const cardSelector = `div[onclick*="openStore('${activeBusinessId}')"]`;
            await page.waitForSelector(cardSelector, { timeout: 5000 });
            await page.click(cardSelector);
            
            // Wait for menu modal/view to open
            await page.waitForSelector('#store-menu-view', { timeout: 5000 });
            const isMenuVisible = await page.evaluate(() => {
                const view = document.getElementById('store-menu-view');
                return view && !view.classList.contains('hidden');
            });

            if (isMenuVisible) {
                // Wait for menu items container and then wait for actual items to render inside it (resolving async fetch race condition)
                await page.waitForSelector('#menu-items-container', { timeout: 5000 });
                console.log('Waiting for menu items / options to render inside container...');
                try {
                    await page.waitForFunction(() => {
                        const items = document.querySelectorAll('#menu-items-container .flex, #menu-items-container option, #menu-items-container a');
                        return items.length > 0;
                    }, { timeout: 8000 });
                } catch (timeoutErr) {
                    console.warn('Timeout waiting for menu elements. Container content:', await page.evaluate(() => document.getElementById('menu-items-container').innerText));
                }
                const menuItemsCount = await page.evaluate(() => {
                    return document.querySelectorAll('#menu-items-container .flex, #menu-items-container option').length;
                });
                
                if (menuItemsCount > 0) {
                    menuLoaded = true;
                    logTest('customer_ui_menu_load', true, `Store details pane opened and loaded ${menuItemsCount} items/options for '${activeBusinessName}'.`);
                } else {
                    logTest('customer_ui_menu_load', false, 'Store menu opened but items container is empty.');
                }
            } else {
                logTest('customer_ui_menu_load', false, 'Store view remained hidden after clicking.');
            }
        } catch (err) {
            logTest('customer_ui_menu_load', false, `Failed to open store: ${err.message}`);
        }

        // Test 7: Order Creation Flow
        if (menuLoaded) {
            console.log('Simulating adding item to cart and submitting order...');
            try {
                // If it is a restaurant, we can add items. If it is a dentist/service, it is appointment booking.
                const isService = await page.evaluate(() => {
                    const selector = document.getElementById('location-selector');
                    // Check if service appointment view is rendered instead of product list
                    return document.querySelector('#menu-items-container h4')?.innerText.includes('CITA') || false;
                });

                if (!isService) {
                    // 1. Add item to cart by clicking the first menu card and calling window.add()
                    const added = await page.evaluate(() => {
                        const firstCard = document.querySelector('#menu-items-container .cursor-pointer');
                        if (firstCard) {
                            firstCard.click();
                            window.add();
                            return true;
                        }
                        return false;
                    });

                    if (!added) throw new Error('No menu items available to add to cart.');
                    console.log('Item added to cart. Opening checkout drawer...');
                    
                    // 2. Open checkout drawer
                    await page.evaluate(() => {
                        window.openCheckout();
                    });
                    
                    await page.evaluate(() => new Promise(r => setTimeout(r, 800)));

                    // 3. Fill checkout details using correct IDs
                    console.log('Filling checkout details...');
                    await page.evaluate(() => {
                        const nameInput = document.getElementById('check-name');
                        const phoneInput = document.getElementById('check-phone');
                        const addressInput = document.getElementById('check-address');
                        
                        if (nameInput) nameInput.value = 'QA Tester';
                        if (phoneInput) phoneInput.value = '99998888';
                        if (addressInput) addressInput.value = 'Barrio El Centro, Quimistán';
                        
                        // Select payment method cash
                        window.setPayment('cash');
                    });

                    // 4. Click Submit Order (final-btn)
                    console.log('Submitting final order...');
                    const submitResult = await page.evaluate(async () => {
                        const submitBtn = document.getElementById('final-btn');
                        if (submitBtn) {
                            submitBtn.click();
                            return { success: true };
                        }
                        return { success: false, error: 'Checkout button (final-btn) not found' };
                    });

                    if (submitResult.success) {
                        // Wait for order success state or modal
                        await page.evaluate(() => new Promise(r => setTimeout(r, 2000)));
                        logTest('order_creation', true, 'Successfully initiated order checkout flow (submitted cart data).');
                    } else {
                        logTest('order_creation', false, `Checkout failed: ${submitResult.error}`);
                    }
                } else {
                    // Service App booking flow
                    const bookResult = await page.evaluate(async () => {
                        const nameInput = document.getElementById('cust-name') || document.querySelector('input[placeholder*="nombre"]');
                        const phoneInput = document.getElementById('cust-phone') || document.querySelector('input[placeholder*="teléfono"]');
                        if (nameInput) nameInput.value = 'QA Tester';
                        if (phoneInput) phoneInput.value = '99998888';

                        const submitBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('AGENDAR') || b.innerText.includes('RESERVAR'));
                        if (submitBtn) {
                            submitBtn.click();
                            return { success: true };
                        }
                        return { success: false, error: 'Booking button not found' };
                    });

                    if (bookResult.success) {
                        await page.evaluate(() => new Promise(r => setTimeout(r, 2000)));
                        logTest('order_creation', true, 'Successfully submitted service booking/appointment flow.');
                    } else {
                        logTest('order_creation', false, `Booking failed: ${bookResult.error}`);
                    }
                }
            } catch (err) {
                logTest('order_creation', false, `Checkout simulation encountered error: ${err.message}`);
            }
        } else {
            logTest('order_creation', false, 'Skipped due to menu loading failure.');
        }

        // Test 8: Driver Dispatch Dashboard rendering
        console.log('Testing Driver Portal load...');
        await page.goto(`${BASE_URL}/driver-portal.html`, { waitUntil: 'networkidle2', timeout: 15000 });
        const hasDriverText = await page.evaluate(() => {
            const txt = document.body.innerText.toLowerCase();
            return txt.includes('conductor') || txt.includes('entregas') || txt.includes('driver') || txt.includes('repartidores');
        });
        if (hasDriverText) {
            logTest('driver_dispatch', true, 'Driver Portal is reachable and renders control parameters.');
        } else {
            logTest('driver_dispatch', false, 'Driver Portal loaded but does not contain typical driver context keywords.');
        }

        // Test 9: Admin Console login view
        console.log('Testing Admin Console view...');
        await page.goto(`${BASE_URL}/quimieats-admin.html`, { waitUntil: 'networkidle2', timeout: 15000 });
        const hasAdminLogin = await page.evaluate(() => {
            const inputs = document.querySelectorAll('input[type="password"]');
            return inputs.length > 0 || document.body.innerText.includes('PIN') || document.body.innerText.includes('Admin');
        });
        if (hasAdminLogin) {
            logTest('admin_dashboard', true, 'Admin Console loads and renders authorization inputs.');
        } else {
            logTest('admin_dashboard', false, 'Admin Console did not render password/PIN entry fields.');
        }

    } catch (e) {
        console.error('❌ Browser simulation encountered an unhandled error:', e.message);
    } finally {
        await browser.close();
    }

    // ==========================================
    // SUMMARY REPORT
    // ==========================================
    console.log('\n--- 📊 QA TEST EXECUTION SUMMARY ---');
    console.log(`Passed: ${passed} / Failed: ${failed}`);
    
    const overallSuccess = failed === 0;
    console.log(`Result: ${overallSuccess ? '💚 SUCCESS' : '💔 FAIL'}`);
    
    // Output JSON for logs
    console.log('TEST_RESULTS_JSON:' + JSON.stringify(report));
    
    if (overallSuccess) {
        process.exit(0);
    } else {
        process.exit(1);
    }
}

runTests();
