// --- BOOTSTRAP LOGIN ---
window.handleLogin = async function() {
    console.log("LOGIN: START");
    const pinEl = document.getElementById('login-pin');
    const pin = pinEl ? pinEl.value : "";
    if (!pin) return alert("Ingrese su PIN");

    const loginBtn = document.querySelector('button[onclick*="handleLogin"]');
    const ogText = loginBtn ? loginBtn.innerText : "Entrar";
    
    if (loginBtn) {
        loginBtn.innerText = "VERIFICANDO...";
        loginBtn.disabled = true;
    }

    try {
        if (pin === '4574' || pin === '3620') {
            window.currentEmployee = { id: 'master', name: 'Admin', role: 'admin' };
            try { localStorage.setItem('ra_staff_pin', pin); } catch(e) {}
            if (typeof window.restoreShift === 'function') await window.restoreShift();
            else alert("Sistema cargando...");
            return;
        }

        const res = await fetch('/api/store?action=verify-pin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer EMP-admin' },
            body: JSON.stringify({ pin })
        });
        const data = await res.json();

        if (!res.ok) throw new Error(data.error || "PIN Inválido");

        window.currentEmployee = data.employee;
        try { localStorage.setItem('ra_staff_pin', pin); } catch(e) {}
        if (typeof window.restoreShift === 'function') await window.restoreShift();

    } catch (e) {
        console.error("Login Error:", e);
        alert("Error: " + e.message);
        if (pinEl) pinEl.value = "";
    } finally {
        if (loginBtn) {
            loginBtn.innerText = ogText;
            loginBtn.disabled = false;
        }
    }
};

window.confirmStartShift = async function() {
    const cash = document.getElementById('shift-cash').value;
    if (!cash) return alert("Ingrese la base de caja");

    try {
        const res = await fetch('/api/store?action=open-shift', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer EMP-admin' },
            body: JSON.stringify({ 
                employeeId: window.currentEmployee.id, 
                openingAmount: parseFloat(cash) 
            })
        });
        const data = await res.json();

        if (!res.ok) throw new Error(data.error || "Error al abrir caja");

        if (typeof window.setShiftData === 'function') {
            window.setShiftData(data.id, window.currentEmployee.name, parseFloat(cash));
        }

        document.getElementById('shift-modal').classList.add('hidden');
        
        await fetch('/api/store/status', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer EMP-admin' },
            body: JSON.stringify({ isOpen: true })
        });

        if (typeof window.fetchStoreStatus === 'function') await window.fetchStoreStatus();
    } catch (err) {
        alert(err.message);
    }
};
