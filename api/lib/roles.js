// api/lib/roles.js
// ROLES (roles build, 2026-10-30) — the ONE place that turns a stored
// employee role (or an owner credential) into the canonical role and
// the capabilities ("caps") the API gates on. ROLES-AND-VIEWS.md is the
// source of truth; this file is its enforcement table.
//
// The four roles (owner's words on screen, canonical keys in code):
//   👑 owner      — todo: precios, banco/ajustes, PINs, financieros.
//   🛠 encargado  — la operación: menú (estructura), recetas, inventario,
//                   conteos, misiones, clientes, preventa, producción,
//                   reportes operativos. SIN precios, SIN costos/márgenes,
//                   SIN banco, SIN PINs ajenos.
//   💵 cajero     — POS (Rico Cash dentro de los topes) y confirmar
//                   preventa. Nada de admin.
//   ☕ barista    — su estación KDS, build cards, Producción. Nada de caja.
//
// Stored vocabulary (employees.role, written by the Employees form and
// older seeds) is messier than the model — barista_cashier, cook,
// manager… — so every gate goes through normalizeRole() and never
// compares raw strings. An unrecognized role gets NO caps: the API
// denies, the person asks the owner to fix their role in Employees.
//
// Hiding a button is never the gate: the handlers call hasCap() on the
// server, per action. An action with no declared cap is Owner-only
// until someone declares one (ROLES-AND-VIEWS.md, "Construcción").

const ROLE_LABELS = {
    owner: '👑 Dueño',
    encargado: '🛠 Encargado',
    cajero: '💵 Cajero',
    barista: '☕ Barista / Cocina'
};

// Every capability the API knows how to ask about.
const ALL_CAPS = [
    'precios',     // cambiar precios (ítems del menú y ajustes de modificadores)
    'banco',       // cuentas bancarias y ajustes del negocio
    'pines',       // empleados y PINs
    'finanzas',    // costos, márgenes y configuración de dinero (Regalos, Difusión, Especial, ledger, topups)
    'menu',        // estructura del menú, modificadores, recetas e ingredientes
    'inventario',  // catálogo de inventario
    'clientes',    // clientes y registros (signups)
    'preventa',    // confirmar preventa pagada
    'misiones',    // crear / activar / aprobar misiones
    'reportes',    // reportes operativos (ventas del día)
    'pos',         // acciones de caja (regalo manual dentro del tope)
    'produccion'   // KDS: build cards, check-off, producción
];

const CAPS_BY_ROLE = {
    owner: ALL_CAPS.slice(),
    encargado: ['menu', 'inventario', 'clientes', 'preventa', 'misiones', 'reportes', 'produccion'],
    cajero: ['pos', 'preventa'],
    barista: ['produccion']
};

// barista_cashier is a real stored role ("Barista / Caja"): one person
// who runs the counter AND the bar. Canonical label: cajero — with the
// barista production caps added, so their KDS keeps working.
const HYBRID_EXTRA_CAPS = {
    barista_cashier: ['produccion']
};

function normalizeRole(raw) {
    const r = String(raw || '').toLowerCase().trim();
    if (!r) return null;
    if (['owner', 'dueno', 'dueño', 'master', 'propietario'].includes(r)) return 'owner';
    if (['admin', 'manager', 'encargado', 'encargada', 'supervisor'].includes(r)) return 'encargado';
    if (['barista_cashier', 'cashier', 'cajero', 'cajera', 'caja'].includes(r)) return 'cajero';
    if (['barista', 'cook', 'cocinero', 'cocinera', 'cocina', 'barista_cook', 'kitchen'].includes(r)) return 'barista';
    return null;
}

// roleFor(storedRole) -> { role, caps } | null
function roleFor(storedRole) {
    const role = normalizeRole(storedRole);
    if (!role) return null;
    const caps = new Set(CAPS_BY_ROLE[role] || []);
    const raw = String(storedRole || '').toLowerCase().trim();
    (HYBRID_EXTRA_CAPS[raw] || []).forEach(c => caps.add(c));
    return { role, caps: [...caps] };
}

function capsFor(storedRole) {
    const r = roleFor(storedRole);
    return r ? r.caps : [];
}

// hasCap(actor, cap) — actor is anything carrying { role } (canonical)
// or { caps }. Owner always passes.
function hasCap(actor, cap) {
    if (!actor) return false;
    if (actor.role === 'owner') return true;
    if (Array.isArray(actor.caps)) return actor.caps.includes(cap);
    return capsFor(actor.role).includes(cap);
}

// True when a stored role belongs to someone who can approve money
// actions with their PIN (the encargado-or-owner rule the POS manual
// grant already used, now in canonical terms).
function isManagerRole(storedRole) {
    const role = normalizeRole(storedRole);
    return role === 'encargado' || role === 'owner';
}

// Denial copy — plain language, always in Spanish, never a stack trace
// and never the bare word "Unauthorized" (THE STANDARD, rule 7: no
// silent or cryptic outcomes).
const DENY_MESSAGES = {
    precios: 'Los precios los cambia solo el dueño. Podés guardar el resto sin tocar el precio.',
    banco: 'Las cuentas y los ajustes del negocio los cambia solo el dueño.',
    pines: 'Los empleados y sus PINs los maneja solo el dueño.',
    finanzas: 'Esa parte maneja costos y dinero de la casa: la ve solo el dueño.'
};

function denyMessage(cap) {
    return DENY_MESSAGES[cap] || 'Tu rol no permite esta acción. Si la necesitás, pedile al dueño o al encargado.';
}

const NO_CREDENTIAL_MESSAGE = 'Necesitás entrar con tu PIN de personal.';

module.exports = {
    ROLE_LABELS,
    ALL_CAPS,
    CAPS_BY_ROLE,
    normalizeRole,
    roleFor,
    capsFor,
    hasCap,
    isManagerRole,
    denyMessage,
    NO_CREDENTIAL_MESSAGE
};
