// offline-manager.js
// Handles IndexedDB storage and offline sync logic using localforage

const STORES = {
    MENU: 'menu_store',
    ORDERS: 'orders_queue',
    REMESAS: 'remesas_queue',
    CUSTOMERS: 'customers_store'
};

// Initialize stores
const menuStore = localforage.createInstance({ name: 'RichAromaDB', storeName: STORES.MENU });
const ordersQueue = localforage.createInstance({ name: 'RichAromaDB', storeName: STORES.ORDERS });
const remesasQueue = localforage.createInstance({ name: 'RichAromaDB', storeName: STORES.REMESAS });
const customersStore = localforage.createInstance({ name: 'RichAromaDB', storeName: STORES.CUSTOMERS });

window.OfflineManager = {
    // Check if online
    isOnline: () => navigator.onLine,

    // --- MENU ---
    async cacheMenu(menuData) {
        try {
            await menuStore.setItem('full_menu', menuData);
            console.log('[Offline] Menu cached');
        } catch (e) {
            console.error('[Offline] Failed to cache menu', e);
        }
    },

    async getCachedMenu() {
        return await menuStore.getItem('full_menu');
    },

    // --- CUSTOMERS ---
    async cacheCustomers(customersData) {
        try {
            await customersStore.setItem('all_customers', customersData);
            console.log('[Offline] Customers cached');
        } catch (e) {
            console.error('[Offline] Failed to cache customers', e);
        }
    },

    async getCachedCustomers() {
        return await customersStore.getItem('all_customers');
    },

    // --- ORDERS ---
    async saveOrderOffline(order) {
        const orderId = `OFF-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        order.id = orderId; // Temp ID
        order.offline = true;
        order.created_at = new Date().toISOString();
        
        await ordersQueue.setItem(orderId, order);
        console.log('[Offline] Order saved to queue:', orderId);
        return order;
    },

    async getPendingOrders() {
        const orders = [];
        await ordersQueue.iterate((value, key) => {
            orders.push(value);
        });
        return orders;
    },

    async clearOrder(orderId) {
        await ordersQueue.removeItem(orderId);
    },

    // --- REMESAS ---
    async saveRemesaOffline(tx) {
        const txId = `OFF-REM-${Date.now()}`;
        tx.id = txId;
        tx.offline = true;
        tx.timestamp = new Date().toISOString();
        
        await remesasQueue.setItem(txId, tx);
        console.log('[Offline] Remesa saved to queue:', txId);
        return tx;
    },

    async getPendingRemesas() {
        const txs = [];
        await remesasQueue.iterate((value) => {
            txs.push(value);
        });
        return txs;
    },

    async clearRemesa(txId) {
        await remesasQueue.removeItem(txId);
    },

    // --- SYNC LOGIC ---
    async syncPendingOrders() {
        if (!this.isOnline()) return;

        const pending = await this.getPendingOrders();
        if (pending.length === 0) return;

        console.log(`[Sync] Found ${pending.length} pending orders`);

        // Send in batch
        try {
            const res = await fetch('/api/sync/batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orders: pending })
            });

            const result = await res.json();
            
            if (result.success) {
                console.log('[Sync] Batch sync successful', result);
                // Clear successfully synced orders
                for (const order of pending) {
                    await this.clearOrder(order.id);
                }
                
                // Notify user
                if (result.syncedCount > 0) {
                    this.showNotification(`Synced ${result.syncedCount} offline orders`);
                }
            } else {
                console.error('[Sync] Batch sync failed', result);
            }
        } catch (e) {
            console.error('[Sync] Network error during sync', e);
        }
    },

    async syncPendingRemesas() {
        if (!this.isOnline()) return;
        const pending = await this.getPendingRemesas();
        if (pending.length === 0) return;

        console.log(`[Sync] Found ${pending.length} pending remesas`);
        
        // We'll upload one by one for now as we didn't make a batch endpoint for remesas
        // Or we can add a batch endpoint.
        // For simplicity, let's just loop.
        
        let synced = 0;
        for (const tx of pending) {
            try {
                // Remove offline props
                const { offline, id, ...data } = tx;
                // Add timestamp if needed by API (or let server set it)
                
                const res = await fetch('/api/remesas/transaction', {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + (localStorage.getItem('ra_staff_pin') || '') 
                    },
                    body: JSON.stringify(data)
                });
                
                if (res.ok) {
                    await this.clearRemesa(tx.id);
                    synced++;
                }
            } catch (e) {
                console.error('Failed to sync remesa', tx.id, e);
            }
        }
        
        if (synced > 0) this.showNotification(`Synced ${synced} remesa transactions`);
    },

    // --- UI HELPERS ---
    showNotification(msg) {
        // Simple toast or alert
        const toast = document.createElement('div');
        toast.style.cssText = `
            position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
            background: #22c55e; color: white; padding: 10px 20px; border-radius: 20px;
            z-index: 9999; font-family: sans-serif; box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        `;
        toast.textContent = msg;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
    }
};

// Auto-sync when coming back online
window.addEventListener('online', () => {
    console.log('[Network] Online - attempting sync');
    window.OfflineManager.syncPendingOrders();
    window.OfflineManager.syncPendingRemesas();
    // Dispatch event for UI updates
    window.dispatchEvent(new CustomEvent('connection-change', { detail: { online: true } }));
});

window.addEventListener('offline', () => {
    console.log('[Network] Offline');
    window.dispatchEvent(new CustomEvent('connection-change', { detail: { online: false } }));
});
