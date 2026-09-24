/**
 * Torneo Futsal 3v3 API - Rich Aroma OS
 * Handles team registration, player invites, free agent matching,
 * match schedules, scores, standings calculation, and stats.
 */

const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '../data/torneo_data.json');

function getTournamentData() {
    try {
        if (!fs.existsSync(DATA_PATH)) {
            return { teams: [], matches: [], freeAgents: [], topScorers: [] };
        }
        const content = fs.readFileSync(DATA_PATH, 'utf8');
        return JSON.parse(content || '{}');
    } catch (e) {
        console.error("Error reading torneo DB:", e);
        return { teams: [], matches: [], freeAgents: [], topScorers: [] };
    }
}

function saveTournamentData(data) {
    try {
        const dir = path.dirname(DATA_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error("Error saving torneo DB:", e);
    }
}

// Calculate standings dynamically from completed matches
function calculateStandings(data) {
    const standings = {
        A: {},
        B: {}
    };

    const confirmedTeams = (data.teams || []).filter(t => t.status === 'Confirmado');
    confirmedTeams.forEach(t => {
        const grp = t.group || 'A';
        if (!standings[grp]) standings[grp] = {};
        standings[grp][t.name] = {
            teamId: t.id,
            teamName: t.name,
            code: t.code,
            group: grp,
            pj: 0,
            pg: 0,
            pe: 0,
            pp: 0,
            gf: 0,
            gc: 0,
            dif: 0,
            pts: 0
        };
    });

    (data.matches || []).forEach(m => {
        if (m.status === 'Finalizado' && m.scoreHome !== null && m.scoreAway !== null) {
            const grp = m.group;
            if (standings[grp]) {
                const home = standings[grp][m.teamHome];
                const away = standings[grp][m.teamAway];

                if (home && away) {
                    home.pj += 1;
                    away.pj += 1;
                    home.gf += m.scoreHome;
                    home.gc += m.scoreAway;
                    away.gf += m.scoreAway;
                    away.gc += m.scoreHome;

                    if (m.scoreHome > m.scoreAway) {
                        home.pg += 1;
                        home.pts += 3;
                        away.pp += 1;
                    } else if (m.scoreHome < m.scoreAway) {
                        away.pg += 1;
                        away.pts += 3;
                        home.pp += 1;
                    } else {
                        home.pe += 1;
                        home.pts += 1;
                        away.pe += 1;
                        away.pts += 1;
                    }

                    home.dif = home.gf - home.gc;
                    away.dif = away.gf - away.gc;
                }
            }
        }
    });

    // Sort standings
    const sortFn = (a, b) => {
        if (b.pts !== a.pts) return b.pts - a.pts;
        if (b.dif !== a.dif) return b.dif - a.dif;
        return b.gf - a.gf;
    };

    return {
        groupA: Object.values(standings.A || {}).sort(sortFn),
        groupB: Object.values(standings.B || {}).sort(sortFn)
    };
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const { action } = req.query || {};
    const url = req.url || '';

    // Route: GET /api/torneo
    if (req.method === 'GET' && (!action || action === 'overview' || url.endsWith('/torneo'))) {
        const data = getTournamentData();
        const standings = calculateStandings(data);

        const confirmedTeams = (data.teams || []).filter(t => t.status === 'Confirmado');
        const availableTeamSlots = Math.max(0, (data.maxTeams || 8) - confirmedTeams.length);

        return res.status(200).json({
            success: true,
            tournament: {
                id: data.id,
                name: data.name,
                subtitle: data.subtitle,
                season: data.season,
                startDate: data.startDate,
                endDate: data.endDate,
                maxTeams: data.maxTeams || 8,
                confirmedTeamsCount: confirmedTeams.length,
                availableTeamSlots,
                teamFeeLempiras: data.teamFeeLempiras || 1800,
                freeAgentFeeLempiras: data.freeAgentFeeLempiras || 360,
                prizePool: data.prizePool,
                rules: data.rules
            },
            teams: data.teams || [],
            standings,
            matches: data.matches || [],
            freeAgents: data.freeAgents || [],
            topScorers: data.topScorers || []
        });
    }

    // Route: POST /api/torneo/register-team
    if (req.method === 'POST' && (action === 'register-team' || url.includes('/register-team'))) {
        try {
            const { teamName, captainName, phone, receiptImageBase64 } = req.body || {};

            if (!teamName || !captainName || !phone) {
                return res.status(400).json({ error: "Nombre del equipo, capitán y teléfono de WhatsApp son requeridos." });
            }

            const data = getTournamentData();
            data.teams = data.teams || [];

            // Check if name already taken
            const exists = data.teams.some(t => t.name.toLowerCase() === teamName.trim().toLowerCase() && t.status === 'Confirmado');
            if (exists) {
                return res.status(400).json({ error: "Ya existe un equipo registrado con ese nombre. Por favor elija otro." });
            }

            const confirmedCount = data.teams.filter(t => t.status === 'Confirmado').length;
            const isWaitlist = confirmedCount >= (data.maxTeams || 8);

            // Generate clean invite code (e.g. COPA-742)
            const cleanPrefix = teamName.trim().substring(0, 4).toUpperCase().replace(/[^A-Z]/g, 'TEAM');
            const randomCode = Math.floor(100 + Math.random() * 900);
            const inviteCode = `${cleanPrefix}-${randomCode}`;

            // Assign group
            const groupACount = data.teams.filter(t => t.group === 'A' && t.status === 'Confirmado').length;
            const groupBCount = data.teams.filter(t => t.group === 'B' && t.status === 'Confirmado').length;
            const assignedGroup = groupACount <= groupBCount ? 'A' : 'B';

            // Check if there's a placeholder team to replace (e.g. Cupo Libre #8)
            const placeholderIndex = data.teams.findIndex(t => t.status === 'Disponible');

            const newTeam = {
                id: `team-${Date.now()}`,
                name: teamName.trim(),
                captain: captainName.trim(),
                phone: phone.trim(),
                code: inviteCode,
                group: assignedGroup,
                status: isWaitlist ? "Lista de Espera" : "Confirmado",
                receiptImage: receiptImageBase64 ? "uploaded" : "pending",
                registeredAt: new Date().toISOString(),
                roster: [
                    {
                        name: captainName.trim(),
                        role: "Capitán",
                        number: 10,
                        phone: phone.trim(),
                        joinedAt: new Date().toISOString()
                    }
                ]
            };

            if (placeholderIndex !== -1 && !isWaitlist) {
                data.teams[placeholderIndex] = newTeam;
            } else {
                data.teams.push(newTeam);
            }

            saveTournamentData(data);

            const inviteLink = `https://richaromacoffee.com/terraza/torneo?join=${inviteCode}`;

            return res.status(201).json({
                success: true,
                message: isWaitlist 
                    ? "Cupos de 8 equipos llenos. Tu equipo quedó registrado en Lista de Espera con prioridad para expansión a 12 o Temporada 2."
                    : "¡Equipo inscrito con éxito en la Copa Futsal 3v3!",
                team: newTeam,
                inviteCode,
                inviteLink,
                isWaitlist
            });
        } catch (e) {
            console.error("Error registering team:", e);
            return res.status(500).json({ error: "Error en el servidor al inscribir equipo." });
        }
    }

    // Route: POST /api/torneo/join-team
    if (req.method === 'POST' && (action === 'join-team' || url.includes('/join-team'))) {
        try {
            const { inviteCode, playerName, phone } = req.body || {};

            if (!inviteCode || !playerName || !phone) {
                return res.status(400).json({ error: "Código de equipo, nombre del jugador y WhatsApp son requeridos." });
            }

            const data = getTournamentData();
            const team = (data.teams || []).find(t => t.code.toUpperCase() === inviteCode.trim().toUpperCase());

            if (!team) {
                return res.status(404).json({ error: "Código de invitación no válido. Verifica el código con tu capitán." });
            }

            team.roster = team.roster || [];
            if (team.roster.length >= 5) {
                return res.status(409).json({ error: "Este equipo ya alcanzó el límite máximo de 5 jugadores en su nómina." });
            }

            // Check if already in roster
            const cleanPhone = phone.replace(/[^0-9]/g, '');
            const alreadyInRoster = team.roster.some(p => (p.phone || '').replace(/[^0-9]/g, '') === cleanPhone);
            if (alreadyInRoster) {
                return res.status(200).json({
                    success: true,
                    alreadyInRoster: true,
                    message: "¡Ya estás registrado en la nómina de este equipo!",
                    team
                });
            }

            const newPlayer = {
                name: playerName.trim(),
                role: "Jugador",
                number: team.roster.length + 1,
                phone: phone.trim(),
                joinedAt: new Date().toISOString()
            };

            team.roster.push(newPlayer);
            saveTournamentData(data);

            return res.status(200).json({
                success: true,
                message: `¡Te has unido exitosamente a ${team.name}!`,
                team,
                player: newPlayer
            });
        } catch (e) {
            console.error("Error joining team:", e);
            return res.status(500).json({ error: "Error en el servidor al unirse al equipo." });
        }
    }

    // Route: POST /api/torneo/free-agent
    if (req.method === 'POST' && (action === 'free-agent' || url.includes('/free-agent'))) {
        try {
            const { name, phone, position, receiptImageBase64 } = req.body || {};

            if (!name || !phone) {
                return res.status(400).json({ error: "Nombre y teléfono de WhatsApp son requeridos." });
            }

            const data = getTournamentData();
            data.freeAgents = data.freeAgents || [];

            const newAgent = {
                id: `fa-${Date.now()}`,
                name: name.trim(),
                phone: phone.trim(),
                position: position || "Polivalente / Libre",
                status: "Disponible",
                receiptImage: receiptImageBase64 ? "uploaded" : "pending",
                registeredAt: new Date().toISOString()
            };

            data.freeAgents.push(newAgent);
            saveTournamentData(data);

            return res.status(201).json({
                success: true,
                message: "¡Te has registrado como Agente Libre! Te notificaremos por WhatsApp en cuanto seas asignado a un equipo.",
                freeAgent: newAgent,
                totalFreeAgents: data.freeAgents.filter(a => a.status === 'Disponible').length
            });
        } catch (e) {
            console.error("Error registering free agent:", e);
            return res.status(500).json({ error: "Error en el servidor al registrar agente libre." });
        }
    }

    // Route: POST /api/torneo/update-match (Admin Scorekeeper / Juez de Mesa)
    if (req.method === 'POST' && (action === 'update-match' || url.includes('/update-match'))) {
        try {
            const { matchId, scoreHome, scoreAway, status } = req.body || {};
            const data = getTournamentData();

            const match = (data.matches || []).find(m => m.id === matchId);
            if (!match) {
                return res.status(404).json({ error: "Partido no encontrado." });
            }

            match.scoreHome = parseInt(scoreHome);
            match.scoreAway = parseInt(scoreAway);
            match.status = status || 'Finalizado';
            match.updatedAt = new Date().toISOString();

            saveTournamentData(data);

            const standings = calculateStandings(data);

            return res.status(200).json({
                success: true,
                message: "Marcador actualizado con éxito.",
                match,
                standings
            });
        } catch (e) {
            console.error("Error updating match score:", e);
            return res.status(500).json({ error: "Error al actualizar marcador." });
        }
    }

    return res.status(404).json({ error: "Endpoint no encontrado en API de Torneo." });
};
