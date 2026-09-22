/**
 * QuimiEats & Rich Aroma OS - Universal Navigation Hub Switcher
 * Allows 1-tap switching between Storefront, POS, Kitchen KDS, Driver Portal, and Master Admin.
 */
(function() {
    // Prevent duplicate injection
    if (document.getElementById('quimi-universal-nav-btn')) return;

    const currentPath = window.location.pathname;

    const navItems = [
        { title: "Tienda / Menú", subtitle: "Vista de Cliente", icon: "fa-shopping-bag", color: "text-amber-400 bg-amber-500/10 border-amber-500/20", url: "/order-simplified.html" },
        { title: "Punto de Venta (POS)", subtitle: "Caja y Registro", icon: "fa-cash-register", color: "text-blue-400 bg-blue-500/10 border-blue-500/20", url: "/pos-v2.html" },
        { title: "Cocina (KDS)", subtitle: "Barista y Comida", icon: "fa-fire-alt", color: "text-orange-400 bg-orange-500/10 border-orange-500/20", url: "/kitchen.html" },
        { title: "Repartidores", subtitle: "Rutas y Envíos", icon: "fa-motorcycle", color: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20", url: "/driver-portal.html" },
        { title: "Terraza Deportiva", subtitle: "Reserva de Canchas", icon: "fa-futbol", color: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20", url: "/terraza.html" },
        { title: "Master Admin", subtitle: "Métricas y Comercios", icon: "fa-sliders-h", color: "text-purple-400 bg-purple-500/10 border-purple-500/20", url: "/quimieats-admin.html" },
        { title: "OS Central Hub", subtitle: "Menú Principal", icon: "fa-th-large", color: "text-gold bg-gold/10 border-gold/20", url: "/os.html" }
    ];

    // Inject Floating Quick Switcher Button
    const floatingBtn = document.createElement('div');
    floatingBtn.id = 'quimi-universal-nav-btn';
    floatingBtn.className = 'fixed bottom-6 left-6 z-[9999]';
    floatingBtn.innerHTML = `
        <button onclick="window.toggleQuimiNavModal()" class="w-13 h-13 p-3.5 rounded-full bg-[#1e1613] text-[#c9a66b] border border-[#c9a66b]/40 shadow-[0_8px_30px_rgb(0,0,0,0.6)] backdrop-blur-md flex items-center justify-center text-lg active:scale-90 transition-all hover:scale-105">
            <i class="fas fa-layer-group"></i>
        </button>
    `;

    // Inject Navigation Modal
    const modal = document.createElement('div');
    modal.id = 'quimi-universal-nav-modal';
    modal.className = 'hidden fixed inset-0 z-[10000] bg-black/80 backdrop-blur-md flex items-center justify-center p-6 animate-in fade-in duration-200';
    modal.onclick = function(e) {
        if (e.target === modal) window.toggleQuimiNavModal();
    };

    let itemsHtml = '';
    navItems.forEach(item => {
        const isCurrent = currentPath.includes(item.url.replace('.html', '')) || (item.url === '/order-simplified.html' && currentPath === '/');
        itemsHtml += `
            <a href="${item.url}" class="p-4 rounded-2xl flex items-center gap-4 transition-all ${isCurrent ? 'bg-white/10 border border-white/20' : 'bg-white/5 border border-white/5 hover:bg-white/10 active:scale-95'}">
                <div class="w-12 h-12 rounded-xl flex items-center justify-center text-xl border ${item.color}">
                    <i class="fas ${item.icon}"></i>
                </div>
                <div class="text-left flex-1">
                    <div class="flex items-center justify-between">
                        <span class="font-black text-sm text-white uppercase tracking-tight">${item.title}</span>
                        ${isCurrent ? '<span class="text-[8px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">Activo</span>' : ''}
                    </div>
                    <span class="text-[9px] text-white/40 font-bold uppercase tracking-widest block mt-0.5">${item.subtitle}</span>
                </div>
            </a>
        `;
    });

    modal.innerHTML = `
        <div class="max-w-sm w-full bg-[#120e0c] rounded-[2.5rem] p-6 border border-[#c9a66b]/30 shadow-2xl space-y-6 text-center">
            <div class="flex items-center justify-between pb-2 border-b border-white/10">
                <div class="flex items-center gap-3 text-left">
                    <div class="w-10 h-10 rounded-xl bg-orange-500/10 border border-orange-500/30 flex items-center justify-center text-orange-400 font-black">
                        QE
                    </div>
                    <div>
                        <h3 class="text-base font-black text-white uppercase tracking-tight">QuimiEats OS Hub</h3>
                        <p class="text-[8px] text-white/40 font-bold uppercase tracking-widest">Navegación Unificada</p>
                    </div>
                </div>
                <button onclick="window.toggleQuimiNavModal()" class="w-9 h-9 rounded-full bg-white/5 flex items-center justify-center text-white/40 hover:text-white">
                    <i class="fas fa-times"></i>
                </button>
            </div>

            <div class="space-y-2.5 max-h-[65vh] overflow-y-auto pr-1">
                ${itemsHtml}
            </div>

            <p class="text-[8px] text-white/20 uppercase font-black tracking-widest pt-2">Rich Aroma OS • Ecosistema Gastronómico</p>
        </div>
    `;

    document.body.appendChild(floatingBtn);
    document.body.appendChild(modal);

    window.toggleQuimiNavModal = function() {
        const m = document.getElementById('quimi-universal-nav-modal');
        if (!m) return;
        m.classList.toggle('hidden');
    };
})();
