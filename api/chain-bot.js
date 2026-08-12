import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { exec } from 'child_process';
import https from 'https';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const botDir = join(__dirname, '../robinhood-chain-bot');

// Global in-memory cache to make dashboard loads extremely fast
let cachedTrending = null;
let cachedTrendingTime = 0;

let cachedEthPrice = 1780.00;
let cachedEthPriceTime = 0;

// Pure Node.js HTTPS helper to bypass node-fetch decompression bugs
function httpsGet(url) {
    return new Promise((resolve, reject) => {
        const options = {
            headers: {
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept": "application/json"
            }
        };
        https.get(url, options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(new Error("Failed to parse JSON response"));
                    }
                } else {
                    reject(new Error(`HTTP status code ${res.statusCode}`));
                }
            });
        }).on('error', (err) => {
            reject(err);
        });
    });
}

export default async function handler(req, res) {
    const endpoint = req.query.endpoint || '';
    
    // Enable CORS manually
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
    );
    
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    const host = req.headers.host || '';
    const isLocal = host.startsWith('localhost') || 
                    host.startsWith('127.0.0.1') || 
                    host.startsWith('::1') ||
                    /^192\.168\./.test(host) ||
                    /^10\./.test(host) ||
                    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host) ||
                    /^169\.254\./.test(host);
    if (!isLocal) {
        return res.status(403).json({ error: 'Access Denied: Private Terminal API' });
    }

    if (endpoint === 'status') {
        const statusPath = join(botDir, 'bot_status.json');
        if (!fs.existsSync(statusPath)) {
            return res.status(200).json({ status: 'offline', error: 'Status file not found' });
        }
        try {
            const stats = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
            const nowSec = Date.now() / 1000;
            if (nowSec - stats.last_update > 300) {
                stats.status = 'offline';
            }
            
            // Query current ETH price with 1-minute caching
            const nowMs = Date.now();
            if (nowMs - cachedEthPriceTime > 60000) {
                try {
                    const ethData = await httpsGet("https://api.dexscreener.com/latest/dex/search?q=ETH");
                    if (ethData.pairs && ethData.pairs.length > 0) {
                        const matched = ethData.pairs.find(p => 
                            (p.chainId === 'ethereum' || p.chainId === 'arbitrum') && 
                            (p.baseToken?.symbol === 'ETH' || p.baseToken?.symbol === 'WETH')
                        );
                        if (matched) {
                            cachedEthPrice = parseFloat(matched.priceUsd) || 1780.00;
                            cachedEthPriceTime = nowMs;
                        }
                    }
                } catch (err) {
                    console.error("Failed to fetch WETH price:", err);
                }
            }
            stats.eth_price_usd = cachedEthPrice;
            
            return res.status(200).json(stats);
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    } 
    
    else if (endpoint === 'positions') {
        const registryPath = join(botDir, 'active_positions.json');
        if (!fs.existsSync(registryPath)) {
            return res.status(200).json({});
        }
        try {
            const positions = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
            return res.status(200).json(positions);
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    } 
    
    else if (endpoint === 'buy') {
        if (req.method !== 'POST') {
            return res.status(405).json({ error: 'Method Not Allowed' });
        }
        
        const { tokenAddress } = req.body;
        if (!tokenAddress || !tokenAddress.startsWith('0x') || tokenAddress.length !== 42) {
            return res.status(400).json({ error: 'Invalid Ethereum contract address' });
        }
        
        // Execute manual swap buy on-chain via venv/bin/python3 and log to bot.log
        const command = `venv/bin/python3 execute_buy.py ${tokenAddress} >> bot.log 2>&1`;
        
        exec(command, { cwd: botDir }, (error, stdout, stderr) => {
            if (error) {
                console.error(`Manual swap execution error: ${error}`);
            }
        });
        
        return res.status(200).json({ success: true, message: `Swap triggered for ${tokenAddress}` });
    } 
    
    else if (endpoint === 'sell') {
        if (req.method !== 'POST') {
            return res.status(405).json({ error: 'Method Not Allowed' });
        }
        
        const { tokenAddress } = req.body;
        if (!tokenAddress || !tokenAddress.startsWith('0x') || tokenAddress.length !== 42) {
            return res.status(400).json({ error: 'Invalid Ethereum contract address' });
        }
        
        // Execute manual swap sell on-chain via venv/bin/python3 and log to bot.log
        const command = `venv/bin/python3 execute_sell.py ${tokenAddress} >> bot.log 2>&1`;
        
        exec(command, { cwd: botDir }, (error, stdout, stderr) => {
            if (error) {
                console.error(`Manual sell execution error: ${error}`);
            }
        });
        
        return res.status(200).json({ success: true, message: `Sell triggered for ${tokenAddress}` });
    } 
    
    else if (endpoint === 'track') {
        if (req.method !== 'POST') {
            return res.status(405).json({ error: 'Method Not Allowed' });
        }
        
        const { tokenAddress, entryPrice } = req.body;
        if (!tokenAddress || !tokenAddress.startsWith('0x') || tokenAddress.length !== 42) {
            return res.status(400).json({ error: 'Invalid Ethereum contract address' });
        }
        
        // Execute token tracking registration in the background and log output to bot.log
        const command = `venv/bin/python3 track_token.py ${tokenAddress} ${entryPrice || 0} >> bot.log 2>&1`;
        
        exec(command, { cwd: botDir }, (error, stdout, stderr) => {
            if (error) {
                console.error(`Token tracking registration execution error: ${error}`);
            }
        });
        
        return res.status(200).json({ success: true, message: `Tracking initiated for ${tokenAddress}` });
    }
    
    else if (endpoint === 'deploy') {
        if (req.method !== 'POST') {
            return res.status(405).json({ error: 'Method Not Allowed' });
        }
        
        const { name, symbol, supply } = req.body;
        if (!name || !symbol || !supply) {
            return res.status(400).json({ error: 'Missing name, symbol, or supply parameters' });
        }
        
        const cleanName = name.replace(/[^a-zA-Z0-9 ]/g, '').trim();
        const cleanSymbol = symbol.replace(/[^a-zA-Z0-9]/g, '').trim();
        const cleanSupply = parseInt(supply);
        
        if (isNaN(cleanSupply) || cleanSupply <= 0) {
            return res.status(400).json({ error: 'Supply must be a positive integer' });
        }
        
        // Execute token contract deployment in the background and log output to bot.log
        const command = `venv/bin/python3 token_deployer_run.py "${cleanName}" "${cleanSymbol}" ${cleanSupply} >> bot.log 2>&1`;
        
        exec(command, { cwd: botDir }, (error, stdout, stderr) => {
            if (error) {
                console.error(`Token deployment execution error: ${error}`);
            }
        });
        
        return res.status(200).json({ success: true, message: `Deployment triggered for ${cleanSymbol}` });
    }
    
    else if (endpoint === 'logs') {
        const logPath = join(botDir, 'bot.log');
        if (!fs.existsSync(logPath)) {
            return res.status(200).json({ logs: 'No logs available.' });
        }
        try {
            const content = fs.readFileSync(logPath, 'utf8');
            const lines = content.split('\n');
            const lastLines = lines.slice(-150).join('\n');
            return res.status(200).json({ logs: lastLines });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    } 
    
    else if (endpoint === 'new') {
        const launchPath = join(botDir, 'new_launches.json');
        if (!fs.existsSync(launchPath)) {
            return res.status(200).json([]);
        }
        try {
            const list = JSON.parse(fs.readFileSync(launchPath, 'utf8'));
            return res.status(200).json(list);
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    }
    
    else if (endpoint === 'history') {
        const historyPath = join(botDir, 'trade_history.json');
        if (!fs.existsSync(historyPath)) {
            return res.status(200).json([]);
        }
        try {
            const list = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
            return res.status(200).json(list);
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    }
    
    else if (endpoint === 'performance') {
        const historyPath = join(botDir, 'trade_history.json');
        if (!fs.existsSync(historyPath)) {
            const empty = { total: 0, wins: 0, losses: 0, winRate: 0, netReturn: 0 };
            return res.status(200).json({ hour: empty, day: empty, week: empty, month: empty, historic: empty });
        }
        try {
            const list = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
            
            // Timezone offset query parameter in minutes (passed from client)
            const tzOffset = parseInt(req.query.tzOffset || 0);
            const nowLocalSec = (Date.now() / 1000) - tzOffset * 60;
            const clientNowDate = new Date(nowLocalSec * 1000);
            
            const year = clientNowDate.getUTCFullYear();
            const month = clientNowDate.getUTCMonth();
            const date = clientNowDate.getUTCDate();
            
            const localTodayStartSec = Date.UTC(year, month, date) / 1000;
            const localYesterdayStartSec = localTodayStartSec - 86400;
            
            const dayOfWeek = clientNowDate.getUTCDay(); // 0 = Sunday
            const localWeekStartSec = localTodayStartSec - dayOfWeek * 86400;
            
            const localMonthStartSec = Date.UTC(year, month, 1) / 1000;
            
            const calcStats = (trades) => {
                const total = trades.length;
                const wins = trades.filter(t => t.p_l_pct > 0).length;
                const losses = total - wins;
                const winRate = total > 0 ? (wins / total * 100) : 0;
                let netReturn = 0;
                trades.forEach(t => {
                    const size = parseFloat(t.entry_size_eth || 0.005);
                    const pl = parseFloat(t.p_l_pct || 0);
                    netReturn += size * (pl / 100);
                });
                return { total, wins, losses, winRate, netReturn };
            };
            
            const todayTrades = list.filter(t => {
                const localTimeSec = t.timestamp - tzOffset * 60;
                return localTimeSec >= localTodayStartSec;
            });
            
            const yesterdayTrades = list.filter(t => {
                const localTimeSec = t.timestamp - tzOffset * 60;
                return localTimeSec >= localYesterdayStartSec && localTimeSec < localTodayStartSec;
            });
            
            const weekTrades = list.filter(t => {
                const localTimeSec = t.timestamp - tzOffset * 60;
                return localTimeSec >= localWeekStartSec;
            });
            
            const monthTrades = list.filter(t => {
                const localTimeSec = t.timestamp - tzOffset * 60;
                return localTimeSec >= localMonthStartSec;
            });
            
            return res.status(200).json({
                hour: calcStats(todayTrades),        // mapped to hour card for 'today'
                day: calcStats(yesterdayTrades),    // mapped to day card for 'yesterday'
                week: calcStats(weekTrades),        // mapped to week card for 'this week'
                month: calcStats(monthTrades),      // mapped to month card for 'this month'
                historic: calcStats(list)
            });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    }
    
    else if (endpoint === 'trending') {
        const nowMs = Date.now();
        if (nowMs - cachedTrendingTime < 15000 && cachedTrending) {
            return res.status(200).json(cachedTrending);
        }
        
        try {
            const data = await httpsGet("https://api.dexscreener.com/latest/dex/search?q=0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
            const pairs = data.pairs || [];
            
            // Filter strictly for pairs active on the 'robinhood' chain
            const robinhoodPairs = pairs.filter(p => p.chainId === 'robinhood');
            
            // Sort by 24h volume
            const sorted = robinhoodPairs.sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0));
            
            // Map top 8 trending pairs
            const results = sorted.slice(0, 8).map(p => ({
                address: p.baseToken?.address,
                name: p.baseToken?.name,
                symbol: p.baseToken?.symbol,
                price: p.priceUsd,
                change: p.priceChange?.h1 || p.priceChange?.h24 || 0,
                volume: p.volume?.h24 || 0,
                liquidity: p.liquidity?.usd || 0,
                imageUrl: p.info?.imageUrl || ''
            }));
            
            cachedTrending = results;
            cachedTrendingTime = nowMs;
            
            return res.status(200).json(results);
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    }
    else if (endpoint === 'evaluate') {
        const { tokenAddress } = req.query;
        if (!tokenAddress || !tokenAddress.startsWith('0x') || tokenAddress.length !== 42) {
            return res.status(400).json({ error: 'Invalid contract address' });
        }
        
        try {
            const data = await httpsGet(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
            const pairs = data.pairs || [];
            const robinhoodPairs = pairs.filter(p => p.chainId === 'robinhood');
            
            if (robinhoodPairs.length === 0) {
                return res.status(200).json({
                    recommendation: 'NO BUY',
                    reasons: ['❌ No Robinhood Chain trading pair found on DexScreener.'],
                    score: -5,
                    details: {
                        name: 'Unknown',
                        symbol: 'UNKNOWN',
                        liquidity: 0,
                        volume: 0,
                        fdv: 0
                    }
                });
            }
            
            const pair = robinhoodPairs.reduce((best, current) => {
                const bestLiq = best.liquidity?.usd || 0;
                const curLiq = current.liquidity?.usd || 0;
                return curLiq > bestLiq ? current : best;
            }, robinhoodPairs[0]);
            
            const liq = pair.liquidity?.usd || 0;
            const vol = pair.volume?.h24 || 0;
            const fdv = pair.fdv || 0;
            const change1h = pair.priceChange?.h1 || 0;
            const change24h = pair.priceChange?.h24 || 0;
            
            const reasons = [];
            let score = 0;
            
            if (liq >= 5000) {
                score += 2;
                reasons.push('✅ Healthy Liquidity: $' + Math.round(liq).toLocaleString() + ' is above safety floor ($5,000).');
            } else if (liq >= 1000) {
                score += 1;
                reasons.push('⚠️ Moderate Liquidity: $' + Math.round(liq).toLocaleString() + ' carries medium slippage risk.');
            } else {
                score -= 3;
                reasons.push('❌ Critical Liquidity: $' + Math.round(liq).toLocaleString() + ' is extremely thin. High slippage/rug risk.');
            }
            
            if (vol >= 3000) {
                score += 1;
                reasons.push('✅ Active Trading: 24h volume is $' + Math.round(vol).toLocaleString() + '.');
            } else {
                reasons.push('⚠️ Low Activity: 24h volume is only $' + Math.round(vol).toLocaleString() + '.');
            }
            
            if (change24h > 150) {
                score -= 1;
                reasons.push('⚠️ Overextended: Up ' + change24h + '% in 24h. High chance of pullback.');
            } else if (change1h > 10) {
                score += 1;
                reasons.push('✅ Strong Momentum: Price rose ' + change1h + '% in the last hour.');
            } else if (change24h < -35) {
                score -= 2;
                reasons.push('❌ Heavy Sell Pressure: Down ' + change24h + '% in 24h.');
            } else {
                reasons.push('ℹ️ Stable Trend: Price action is relatively steady.');
            }
            
            const recommendation = score >= 2 ? 'BUY' : 'NO BUY';
            
            return res.status(200).json({
                recommendation,
                reasons,
                score,
                details: {
                    name: pair.baseToken?.name || 'Unknown',
                    symbol: pair.baseToken?.symbol || 'UNKNOWN',
                    liquidity: liq,
                    volume: vol,
                    fdv: fdv,
                    change1h,
                    change24h,
                    pairUrl: pair.url
                }
            });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    }
    else if (endpoint === 'watchlist') {
        const watchlistPath = join(botDir, 'watchlist.json');
        
        if (req.method === 'GET') {
            if (!fs.existsSync(watchlistPath)) {
                return res.status(200).json({});
            }
            try {
                const list = JSON.parse(fs.readFileSync(watchlistPath, 'utf8'));
                return res.status(200).json(list);
            } catch (e) {
                return res.status(500).json({ error: e.message });
            }
        } 
        
        else if (req.method === 'POST') {
            const { tokenAddress, symbol, name, targetReclaimPrice, action } = req.body;
            
            // Handle delete action routed via POST
            if (action === 'delete') {
                if (!tokenAddress) {
                    return res.status(400).json({ error: 'Token address required' });
                }
                const cleanAddr = tokenAddress.toLowerCase();
                let watchlist = {};
                if (fs.existsSync(watchlistPath)) {
                    try {
                        watchlist = JSON.parse(fs.readFileSync(watchlistPath, 'utf8'));
                    } catch (e) {}
                }
                if (watchlist[cleanAddr]) {
                    delete watchlist[cleanAddr];
                    try {
                        fs.writeFileSync(watchlistPath, JSON.stringify(watchlist, null, 2));
                        return res.status(200).json({ success: true, message: `Removed ${tokenAddress} from watchlist` });
                    } catch (e) {
                        return res.status(500).json({ error: e.message });
                    }
                } else {
                    return res.status(404).json({ error: 'Token not found on watchlist' });
                }
            }

            if (!tokenAddress || !tokenAddress.startsWith('0x') || tokenAddress.length !== 42) {
                return res.status(400).json({ error: 'Invalid Ethereum contract address' });
            }
            
            const cleanAddr = tokenAddress.toLowerCase();
            let watchlist = {};
            if (fs.existsSync(watchlistPath)) {
                try {
                    watchlist = JSON.parse(fs.readFileSync(watchlistPath, 'utf8'));
                } catch (e) {}
            }
            
            const finalSymbol = (symbol || 'UNKNOWN').toUpperCase();
            const finalName = name || 'Unknown Token';
            const finalPrice = parseFloat(targetReclaimPrice) || 0.0;
            
            watchlist[cleanAddr] = {
                symbol: finalSymbol,
                name: finalName,
                target_reclaim_price: finalPrice,
                last_bottom_price: finalPrice > 0 ? finalPrice : 0.0
            };
            
            try {
                fs.writeFileSync(watchlistPath, JSON.stringify(watchlist, null, 2));
                return res.status(200).json({ success: true, message: `Added ${finalSymbol} to watchlist` });
            } catch (e) {
                return res.status(500).json({ error: e.message });
            }
        } 
        
        else if (req.method === 'DELETE') {
            const tokenAddress = req.body.tokenAddress || req.query.tokenAddress;
            if (!tokenAddress) {
                return res.status(400).json({ error: 'Token address required' });
            }
            
            const cleanAddr = tokenAddress.toLowerCase();
            let watchlist = {};
            if (fs.existsSync(watchlistPath)) {
                try {
                    watchlist = JSON.parse(fs.readFileSync(watchlistPath, 'utf8'));
                } catch (e) {}
            }
            
            if (watchlist[cleanAddr]) {
                delete watchlist[cleanAddr];
                try {
                    fs.writeFileSync(watchlistPath, JSON.stringify(watchlist, null, 2));
                    return res.status(200).json({ success: true, message: `Removed ${tokenAddress} from watchlist` });
                } catch (e) {
                    return res.status(500).json({ error: e.message });
                }
            } else {
                return res.status(404).json({ error: 'Token not found on watchlist' });
            }
        }
        
        else {
            return res.status(405).json({ error: 'Method Not Allowed' });
        }
    }
    
    else {
        return res.status(404).json({ error: 'Endpoint Not Found' });
    }
}
