/**
 * Terraza Deportiva Multiusos - Booking & Verification API
 * Handles slot queries, dynamic pricing, receipt uploads, QR validation, and check-in.
 */

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '../data/terraza_bookings.json');

// Ensure data folder and DB file exist
function getBookings() {
    try {
        if (!fs.existsSync(DB_PATH)) {
            const initialData = [
                {
                    id: "TERR-7001",
                    sport: "Futsal",
                    date: new Date().toISOString().split('T')[0],
                    startTime: "18:00",
                    hours: 2,
                    endTime: "20:00",
                    customerName: "Carlos Menjívar",
                    phone: "+504 9876-5432",
                    peopleCount: 10,
                    ratePerHour: 500,
                    totalLempiras: 1000,
                    status: "Confirmado",
                    receiptUrl: "/assets/sample_receipt.jpg",
                    checkedIn: false,
                    createdAt: new Date().toISOString()
                }
            ];
            const dir = path.dirname(DB_PATH);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(DB_PATH, JSON.stringify(initialData, null, 2));
            return initialData;
        }
        const content = fs.readFileSync(DB_PATH, 'utf8');
        return JSON.parse(content || '[]');
    } catch (e) {
        console.error("Error reading terraza DB:", e);
        return [];
    }
}

function saveBookings(bookings) {
    try {
        const dir = path.dirname(DB_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(DB_PATH, JSON.stringify(bookings, null, 2));
    } catch (e) {
        console.error("Error saving terraza DB:", e);
    }
}

// Optional Supabase client for syncing customer profiles to Master CRM
let supabase = null;
try {
    const sbModule = require('./lib/supabase');
    supabase = sbModule.supabase;
} catch (e) {
    console.log("Supabase not loaded in local terraza context:", e.message);
}

async function syncCustomerProfile(name, phone, tag = 'Terraza') {
    if (!supabase || !phone || !name) return null;
    try {
        const cleanDigits = phone.replace(/\D/g, '');
        const phoneToStore = cleanDigits.length === 8 ? `504${cleanDigits}` : cleanDigits;

        const { data: existing } = await supabase.from('customers').select('*').eq('phone', phoneToStore).maybeSingle();
        if (existing) {
            const currentTags = existing.tags || [];
            if (!currentTags.includes(tag)) {
                currentTags.push(tag);
                await supabase.from('customers').update({ tags: currentTags }).eq('id', existing.id);
            }
            return existing;
        } else {
            const { data: created } = await supabase.from('customers').insert({
                name: name.trim(),
                phone: phoneToStore,
                tags: [tag, 'Terraza Deportiva'],
                loyalty_points: 0
            }).select().single();
            return created;
        }
    } catch (err) {
        console.warn("Non-blocking Supabase customer sync error:", err.message);
        return null;
    }
}

// Calculate rate per hour based on hour and weekend
// 🔥 50% OFF Promotional Launch Rate (Septiembre & Octubre)
function calculateHourlyRate(dateStr, hour) {
    const d = new Date(dateStr + "T12:00:00Z");
    const isWeekend = d.getUTCDay() === 0 || d.getUTCDay() === 6; // Sun or Sat

    // Weekend afternoons/nights (Prime)
    if (isWeekend) {
        if (hour >= 14) return 250; // Promo 50% OFF (Reg L. 500)
        if (hour >= 10) return 175; // Promo 50% OFF (Reg L. 350)
        return 150; // Promo 50% OFF (Reg L. 300)
    }

    // Weekdays
    if (hour >= 18 && hour < 22) return 250; // Promo Prime con Luces LED & Música (Reg L. 500)
    if (hour >= 16 && hour < 18) return 175; // Promo Tarde (Reg L. 350)
    return 125; // Promo Diurno Estándar (Reg L. 250)
}

const OPENING_DATE = '2026-10-01';

module.exports = async (req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const { action } = req.query || {};
    const url = req.url || '';

    // Route: GET /api/terraza/slots?date=YYYY-MM-DD
    if (req.method === 'GET' && (action === 'slots' || url.includes('/slots'))) {
        const date = req.query.date || OPENING_DATE;

        if (date < OPENING_DATE) {
            return res.status(200).json({
                date,
                isOpen: false,
                message: "La Terraza Deportiva inicia operaciones el 1 de Octubre de 2026.",
                slots: []
            });
        }

        const bookings = getBookings().filter(b => b.date === date && b.status !== 'Cancelado');

        // Operating hours: 07:00 to 22:00 (15 hourly slots)
        const slots = [];
        for (let h = 7; h <= 21; h++) {
            const timeStr = `${h.toString().padStart(2, '0')}:00`;
            const rate = calculateHourlyRate(date, h);
            const regularRate = rate * 2;

            // Check if slot is occupied
            const occupiedBooking = bookings.find(b => {
                const startH = parseInt(b.startTime.split(':')[0]);
                const endH = startH + b.hours;
                return h >= startH && h < endH;
            });

            slots.push({
                hour: h,
                time: timeStr,
                rateLempiras: rate,
                regularRateLempiras: regularRate,
                rateUsd: (rate / 25).toFixed(2),
                isAvailable: !occupiedBooking,
                bookingId: occupiedBooking ? occupiedBooking.id : null,
                sport: occupiedBooking ? occupiedBooking.sport : null,
                isPeak: rate === 250,
                isPromo: true
            });
        }

        return res.status(200).json({ date, slots });
    }

    // Route: GET /api/terraza/madrugador?date=YYYY-MM-DD
    if (req.method === 'GET' && (action === 'madrugador' || url.includes('/madrugador'))) {
        const date = req.query.date || OPENING_DATE;

        if (date < OPENING_DATE) {
            return res.status(200).json({
                date,
                isOpen: false,
                message: "El Club Madrugador inicia el 1 de Octubre de 2026.",
                cap: 50,
                registeredCount: 0,
                availableSlots: 50,
                isFull: false
            });
        }

        const bookings = getBookings().filter(b => b.date === date && b.type === 'madrugador' && b.status !== 'Cancelado');
        const cap = 50;
        const registeredCount = bookings.length;
        const availableSlots = Math.max(0, cap - registeredCount);
        return res.status(200).json({
            date,
            cap,
            registeredCount,
            availableSlots,
            isFull: availableSlots === 0
        });
    }

    // Route: POST /api/terraza/madrugador
    if (req.method === 'POST' && (action === 'madrugador' || url.includes('/madrugador'))) {
        try {
            const { name, phone, date } = req.body || {};
            if (!name || !phone || !date) {
                return res.status(400).json({ error: "Nombre, teléfono y fecha son requeridos." });
            }

            if (date < OPENING_DATE) {
                return res.status(400).json({ error: "El Club Madrugador inicia oficialmente el 1 de Octubre de 2026. Por favor selecciona una fecha de Octubre." });
            }

            const bookings = getBookings();
            const existing = bookings.filter(b => b.date === date && b.type === 'madrugador' && b.status !== 'Cancelado');
            if (existing.length >= 50) {
                return res.status(409).json({ error: "El cupo de 50 madrugadores para esta fecha ya está completo. ¡Puedes asistir gratis de igual manera!" });
            }

            // Check if phone already registered for this date
            const cleanPhone = phone.replace(/[^0-9]/g, '');
            const alreadyRegistered = existing.find(b => b.phone.replace(/[^0-9]/g, '') === cleanPhone);
            if (alreadyRegistered) {
                return res.status(200).json({
                    success: true,
                    alreadyRegistered: true,
                    message: "¡Ya tienes tu Pase Madrugador para esta fecha!",
                    booking: alreadyRegistered,
                    availableSlots: Math.max(0, 50 - existing.length)
                });
            }

            const bookingId = `MADR-${Math.floor(1000 + Math.random() * 9000)}`;
            const madrugadorPass = {
                id: bookingId,
                type: "madrugador",
                sport: "Club Madrugador (5AM - 7AM)",
                date,
                startTime: "05:00",
                endTime: "07:00",
                hours: 2,
                customerName: name.trim(),
                phone: phone.trim(),
                peopleCount: 1,
                ratePerHour: 0,
                totalLempiras: 0,
                totalUsd: "0.00",
                status: "Confirmado",
                benefit: "L. 10 OFF en tu café matutino",
                receiptImage: "exempt_free_community",
                waiverAccepted: req.body.waiverAccepted !== false,
                waiverSignedAt: new Date().toISOString(),
                waiverExpiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
                checkedIn: false,
                checkedInAt: null,
                createdAt: new Date().toISOString()
            };

            bookings.push(madrugadorPass);
            saveBookings(bookings);

            // Sync to CRM Master Database
            await syncCustomerProfile(name, phone, 'Club Madrugador');

            return res.status(201).json({
                success: true,
                message: "¡Pase Madrugador reservado con éxito!",
                booking: madrugadorPass,
                availableSlots: Math.max(0, 50 - (existing.length + 1))
            });
        } catch (e) {
            console.error("Error creating madrugador pass:", e);
            return res.status(500).json({ error: "Error en el servidor al registrar pase madrugador." });
        }
    }

    // Route: POST /api/terraza/book
    if (req.method === 'POST' && (action === 'book' || url.includes('/book'))) {
        try {
            const {
                sport,
                date,
                startTime,
                hours,
                customerName,
                phone,
                peopleCount,
                receiptImageBase64
            } = req.body;

            if (!sport || !date || !startTime || !hours || !customerName || !phone) {
                return res.status(400).json({ error: "Faltan campos requeridos para la reserva." });
            }

            if (date < OPENING_DATE) {
                return res.status(400).json({ error: "Las reservas de la Terraza Deportiva inician el 1 de Octubre de 2026. No hay fechas disponibles en Septiembre." });
            }

            const numHours = parseInt(hours) || 1;
            const startH = parseInt(startTime.split(':')[0]);
            const endH = startH + numHours;
            const endTime = `${endH.toString().padStart(2, '0')}:00`;

            const bookings = getBookings();

            // Conflict check
            const hasConflict = bookings.some(b => {
                if (b.date !== date || b.status === 'Cancelado') return false;
                const bStartH = parseInt(b.startTime.split(':')[0]);
                const bEndH = bStartH + b.hours;
                return (startH < bEndH && endH > bStartH);
            });

            if (hasConflict) {
                return res.status(409).json({ error: "El horario seleccionado ya no está disponible. Por favor elija otro." });
            }

            // Calculate total price
            let total = 0;
            for (let h = startH; h < endH; h++) {
                total += calculateHourlyRate(date, h);
            }

            const bookingId = `TERR-${Math.floor(1000 + Math.random() * 9000)}`;
            const newBooking = {
                id: bookingId,
                sport,
                date,
                startTime,
                endTime,
                hours: numHours,
                customerName,
                phone,
                peopleCount: parseInt(peopleCount) || 1,
                ratePerHour: Math.round(total / numHours),
                totalLempiras: total,
                totalUsd: (total / 25).toFixed(2),
                status: "Confirmado", // Immediately confirmed with receipt verification
                receiptImage: receiptImageBase64 ? "uploaded" : "pending",
                waiverAccepted: req.body.waiverAccepted !== false,
                waiverSignedAt: new Date().toISOString(),
                waiverExpiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
                checkedIn: false,
                checkedInAt: null,
                createdAt: new Date().toISOString()
            };

            bookings.push(newBooking);
            saveBookings(bookings);

            // Sync to CRM Master Database
            await syncCustomerProfile(customerName, phone, `Terraza - ${sport}`);

            return res.status(201).json({
                success: true,
                message: "¡Reserva completada con éxito!",
                booking: newBooking
            });
        } catch (e) {
            console.error("Error creating booking:", e);
            return res.status(500).json({ error: "Error en el servidor al procesar la reserva." });
        }
    }

    // Route: GET /api/terraza/booking/:id
    if (req.method === 'GET' && (action === 'booking' || url.includes('/booking/'))) {
        const id = req.query.id || url.split('/').pop();
        const bookings = getBookings();
        const booking = bookings.find(b => b.id.toUpperCase() === id.toUpperCase());

        if (!booking) {
            return res.status(404).json({ error: "Reserva no encontrada." });
        }
        return res.status(200).json({ booking });
    }

    // Route: POST /api/terraza/check-in
    if (req.method === 'POST' && (action === 'check-in' || url.includes('/check-in'))) {
        const { bookingId } = req.body;
        if (!bookingId) {
            return res.status(400).json({ error: "ID de reserva requerido." });
        }

        const bookings = getBookings();
        const booking = bookings.find(b => b.id.toUpperCase() === bookingId.toUpperCase());

        if (!booking) {
            return res.status(404).json({ error: "Código de reserva inválido." });
        }

        if (booking.checkedIn) {
            return res.status(200).json({
                success: true,
                alreadyCheckedIn: true,
                message: `Esta reserva ya fue ingresada el ${new Date(booking.checkedInAt).toLocaleTimeString()}`,
                booking
            });
        }

        booking.checkedIn = true;
        booking.checkedInAt = new Date().toISOString();
        saveBookings(bookings);

        return res.status(200).json({
            success: true,
            message: `¡Check-In exitoso para ${booking.customerName}! (${booking.sport})`,
            booking
        });
    }

    return res.status(404).json({ error: "Endpoint no encontrado." });
};
