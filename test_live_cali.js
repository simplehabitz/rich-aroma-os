// test_live_cali.js
const puppeteer = require('puppeteer');

(async () => {
    console.log('Launching browser to check live production...');
    const browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        headless: true
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
    page.on('pageerror', err => console.error('BROWSER ERROR:', err.message));

    try {
        console.log('Navigating to Cali page...');
        await page.goto(process.env.TEST_URL || 'https://www.richaromacoffee.com/cali', { waitUntil: 'networkidle2', timeout: 30000 });

        // Wait for locations to load
        console.log('Waiting for dropdown locations to load...');
        await page.waitForFunction(() => {
            const select = document.getElementById('cust-location');
            return select && select.options.length > 1;
        }, { timeout: 15000 });

        // Print loaded options
        const locations = await page.evaluate(() => {
            const select = document.getElementById('cust-location');
            return Array.from(select.options).map(o => ({ value: o.value, text: o.text }));
        });
        console.log('Production dropdown locations:', locations.map(o => o.text));

        const ivyOption = locations.find(o => o.text.includes('The Ivy Residences'));
        if (ivyOption) {
            if (ivyOption.text.includes('Chino')) {
                console.log('✅ Success! The Ivy Residences city is correctly listed as Chino!');
            } else {
                console.log(`❌ Failure: Ivy Residences city is wrong: ${ivyOption.text}`);
            }
            if (locations[1].value === ivyOption.value) {
                console.log('✅ Success! The Ivy Residences is sorted to the top (first option)!');
            } else {
                console.log(`❌ Failure: The Ivy is not the first option. First is: ${locations[1].text}`);
            }
            
            // Check tracker visibility for Ivy
            console.log('Selecting The Ivy option to verify tracker visibility...');
            await page.select('#cust-location', ivyOption.value);
            await new Promise(r => setTimeout(r, 1000));
            const trackerVisible = await page.evaluate(() => {
                const tracker = document.getElementById('hub-tracker-card');
                return tracker && !tracker.classList.contains('hidden');
            });
            if (trackerVisible) {
                console.log('❌ Failure: Tracker card should be hidden for Ivy Residences.');
            } else {
                console.log('✅ Success! Tracker card is correctly hidden for Ivy Residences (no limit).');
            }
        } else {
            console.log('❌ Failure: The Ivy Residences is missing in production dropdown.');
        }

        const fontanaOption = locations.find(o => o.text.includes('Kaiser Fontana'));
        if (fontanaOption) {
            console.log('✅ Success! Kaiser Fontana is live in production!');
        } else {
            console.log('❌ Failure: Kaiser Fontana is missing.');
        }

        // Find and click the "Classic Black Americano" card to customize
        console.log('Opening customization modal for Classic Black Americano...');
        await page.evaluate(() => {
            const cards = Array.from(document.querySelectorAll('div[onclick^="selectProduct"]'));
            const blackCard = cards.find(c => c.innerText.toLowerCase().includes('black') || c.innerText.toLowerCase().includes('americano'));
            if (blackCard) {
                blackCard.click();
            } else {
                console.error("Could not find Classic Black Americano product card");
                if (cards[0]) cards[0].click();
            }
        });

        await new Promise(r => setTimeout(r, 1000));

        // Check if "Classic Black Americano" is selected
        const hasClassicBlackSelection = await page.evaluate(() => {
            const card = Array.from(document.querySelectorAll('div[onclick^="selectProduct"]')).find(c => c.innerText.toLowerCase().includes('black') || c.innerText.toLowerCase().includes('americano'));
            if (!card) return { present: false, active: false };
            const isActive = card.classList.contains('border-brand-brown') && card.classList.contains('bg-brand-cream');
            return { present: true, active: isActive };
        });

        if (hasClassicBlackSelection.present) {
            console.log('✅ Success! Classic Black Americano is available in the menu.');
            if (hasClassicBlackSelection.active) {
                console.log('✅ Success! Classic Black Americano is SELECTED!');
            } else {
                console.log('❌ Failure: Classic Black Americano is not selected.');
            }
        } else {
            console.log('❌ Failure: Classic Black Americano option is missing.');
        }

        // Check if espresso level buttons are rendered and correct for Classic Black (should be 2oz, 3oz, 4oz)
        const espressoButtons = await page.evaluate(() => {
            const labels = Array.from(document.querySelectorAll('label'));
            const label = labels.find(l => l.textContent.includes('Espresso Strength') || l.innerText.toLowerCase().includes('espresso strength'));
            if (!label) return [];
            const container = label.nextElementSibling;
            if (!container) return [];
            return Array.from(container.querySelectorAll('button')).map(b => b.innerText.replace(/\n/g, ' '));
        });
        console.log('Cali Espresso buttons for Classic Black:', espressoButtons);

        if (espressoButtons.length !== 3) {
            throw new Error(`Expected 3 espresso levels on live page, got ${espressoButtons.length}`);
        }
        if (!espressoButtons.some(t => t.toLowerCase().includes('2oz')) || !espressoButtons.some(t => t.toLowerCase().includes('3oz')) || !espressoButtons.some(t => t.toLowerCase().includes('4oz'))) {
            throw new Error('Espresso level button values are incorrect for Classic Black');
        }
        console.log('✅ Success! Espresso levels correctly display 2oz, 3oz, and 4oz for Classic Black.');

        // Check if Event Catering card is present in the product grid
        const hasCateringCard = await page.evaluate(() => {
            const cards = Array.from(document.querySelectorAll('div[onclick^="selectProduct"]'));
            return cards.some(c => c.innerText.toLowerCase().includes('catering') || c.innerText.toLowerCase().includes('event'));
        });
        if (hasCateringCard) {
            console.log('✅ Success! Event Catering card is present on the live production page!');
        } else {
            console.log('❌ Failure: Event Catering card is missing in production.');
        }

    } catch (e) {
        console.error('❌ Test failed:', e);
    } finally {
        await browser.close();
    }
})();
