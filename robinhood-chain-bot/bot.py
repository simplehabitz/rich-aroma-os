import asyncio
import time
import requests
import os
import json
from datetime import datetime
import config
from db_manager import DBManager
from token_scanner import TokenScanner
from momentum_tracker import MomentumTracker
from self_optimizer import SelfOptimizer
from auto_trader import AutoTrader

class TelegramBot:
    def __init__(self):
        self.db = DBManager()
        self.scanner = TokenScanner()
        self.tracker = MomentumTracker()
        self.optimizer = SelfOptimizer()
        self.trader = AutoTrader(self.scanner.w3)
        self.last_heartbeat_time = time.time()
        
        self.active_monitors = {}
        self.load_active_positions()
        
        self.watchlist_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'watchlist.json')
        self.watchlist = {}
        self.load_watchlist()
        
        self.trending_history = {}
        self.last_momentum_alert = {}
        self.pending_momentum_alerts = {}
        self.last_momentum_dispatch = time.time()
        self.pending_launches = {}
        
        self.tracked_wallets_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tracked_wallets.json')
        self.tracked_wallets = {}
        self.load_tracked_wallets()

        self.wallet_metrics_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'wallet_metrics.json')
        self.wallet_metrics = {}
        self.load_wallet_metrics()

    def load_tracked_wallets(self):
        """Load tracked whale wallets from local config"""
        import os
        import json
        if os.path.exists(self.tracked_wallets_file):
            try:
                with open(self.tracked_wallets_file, 'r') as f:
                    self.tracked_wallets = json.load(f)
                    print(f"[Bot] Loaded {len(self.tracked_wallets)} smart money wallets to track.")
            except Exception as e:
                print(f"[Bot] Error loading tracked_wallets.json: {str(e)}")

    def load_wallet_metrics(self):
        """Load calculated wallet metrics/win-rates from cache"""
        import os
        import json
        if os.path.exists(self.wallet_metrics_file):
            try:
                with open(self.wallet_metrics_file, 'r') as f:
                    self.wallet_metrics = json.load(f)
                    print(f"[Bot] Loaded cached metrics for {len(self.wallet_metrics)} wallets.")
            except Exception as e:
                print(f"[Bot] Error loading wallet_metrics.json: {str(e)}")

    def is_copy_trade_eligible(self, wallet_address):
        """Checks if a wallet is eligible for copy trading based on config & win rate"""
        wallet_lower = wallet_address.lower()
        if not getattr(config, "COPY_TRADE_SMART_MONEY", False):
            return False
            
        # Unconditional copy-trade list
        if wallet_lower in getattr(config, "COPY_TRADE_WALLETS", []):
            return True
            
        # Otherwise check win rate / trade count threshold
        metrics = self.wallet_metrics.get(wallet_lower)
        if metrics:
            win_rate = metrics.get('win_rate', 0.0)
            total_trades = metrics.get('total_trades', 0)
            if win_rate >= getattr(config, "AUTO_COPY_MIN_WIN_RATE", 65.0) and total_trades >= getattr(config, "AUTO_COPY_MIN_TRADES", 3):
                return True
                
        return False

    async def background_metrics_audit_loop(self):
        """Periodically runs on-chain audits for all tracked wallets to update win-rates"""
        from wallet_auditor import WalletAuditor
        auditor = WalletAuditor(config.RPC_URL)
        
        while True:
            try:
                print("[Auditor] Triggering scheduled smart money performance audit...")
                # Run audit on all tracked wallets
                await asyncio.to_thread(auditor.audit_all_tracked_wallets, self.tracked_wallets, block_range=1500000)
                self.load_wallet_metrics()
            except Exception as e:
                print(f"[Auditor] Error in scheduled audit loop: {str(e)}")
            # Sleep for 12 hours
            await asyncio.sleep(12 * 3600)

    async def execute_copy_mint(self, nft_contract, value_wei, input_data, label, original_tx_hash):
        """Replay an NFT mint transaction on-chain to copy-mint early launches"""
        try:
            w3 = self.scanner.w3
            nft_checksum = w3.to_checksum_address(nft_contract)
            
            # Check maximum mint price limit
            max_price_wei = int(config.MAX_NFT_MINT_PRICE_ETH * 10**18)
            if value_wei > max_price_wei:
                print(f"[Copy Mint] Mint price {w3.from_wei(value_wei, 'ether'):.4f} ETH exceeds max limit of {config.MAX_NFT_MINT_PRICE_ETH} ETH. Skipping.")
                return
                
            # Check gas balance
            native_bal = w3.eth.get_balance(self.trader.address)
            if native_bal < w3.to_wei(0.001, 'ether'):
                print(f"[Copy Mint] Native gas balance {w3.from_wei(native_bal, 'ether'):.6f} ETH is too low. Skipping.")
                return
                
            self.send_alert(
                f"🎨 *NFT COPY-MINT TRIGGERED*\n"
                f"-----------------------------------------\n"
                f"• Contract: `{nft_contract}`\n"
                f"• Price: {w3.from_wei(value_wei, 'ether'):.4f} ETH\n"
                f"• Followed Wallet: *{label}*\n"
                f"• Replaying original Tx: [View Transaction](https://explorer.chain.robinhood.com/tx/{original_tx_hash})"
            )
            
            if not config.TRADE_EXECUTION_ENABLED:
                print("[Copy Mint] Simulation mode. Skipping actual on-chain transaction broadcast.")
                return
                
            # Build replay transaction
            nonce = w3.eth.get_transaction_count(self.trader.address)
            gas_price_buffered = int(w3.eth.gas_price * 1.5)
            
            tx = {
                'from': self.trader.address,
                'to': nft_checksum,
                'value': value_wei,
                'data': input_data,
                'nonce': nonce,
                'gas': 350000, # Standard safe limit for mints
                'gasPrice': gas_price_buffered
            }
            
            # Estimate gas to verify if allowlist Merkle Proof or balance check fails
            try:
                gas_est = w3.eth.estimate_gas(tx)
                tx['gas'] = int(gas_est * 1.2) # Add 20% gas buffer
            except Exception as e:
                print(f"[Copy Mint] Gas estimation failed for replay mint. Reverting. Error: {str(e)}")
                self.send_alert(f"❌ *NFT COPY-MINT FAILED*\nGas estimation reverted. The mint is likely allowlist-restricted (Merkle Proof failed) or sold out.")
                return
                
            # Sign and send transaction
            signed_tx = w3.eth.account.sign_transaction(tx, self.trader.private_key)
            tx_hash = w3.eth.send_raw_transaction(signed_tx.raw_transaction)
            print(f"[Copy Mint] Mint transaction broadcasted! Hash: {tx_hash.hex()}")
            
            receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=30)
            if receipt.status == 1:
                self.send_alert(
                    f"✅ *NFT COPY-MINT SUCCESSFUL!*\n"
                    f"• Contract: `{nft_contract}`\n"
                    f"• Tx Hash: [View Receipt](https://explorer.chain.robinhood.com/tx/{tx_hash.hex()})"
                )
            else:
                self.send_alert(f"❌ *NFT COPY-MINT REVERTED ON-CHAIN*")
        except Exception as e:
            print(f"[Copy Mint] Error executing copy mint: {str(e)}")

    async def execute_copy_buy(self, token_addr, symbol, name, label, pair_data, from_addr):
        """Executes a copy trade buy swap for a smart money wallet"""
        try:
            token_addr_lower = token_addr.lower()
            
            # Check Daily Drawdown Lockout
            if self.check_daily_drawdown_lockout():
                print(f"[Copy Buy] Daily Drawdown Lockout is Active. Skipping buy for {symbol}.")
                return
                
            # Check Circuit Breaker
            cb_triggered, cb_loss = self.check_circuit_breaker()
            if cb_triggered:
                print(f"[Copy Buy] Circuit Breaker Active. Skipping buy for {symbol}.")
                return
                
            # Check Daily Profit Goal
            goal_hit, today_gain = self.check_daily_profit_goal()
            if goal_hit:
                print(f"[Copy Buy] Daily Profit Goal Hit. Skipping buy for {symbol}.")
                return
                
            # Check Max Concurrent Positions
            max_positions = getattr(config, "MAX_CONCURRENT_POSITIONS", 3)
            if len(self.active_monitors) >= max_positions:
                print(f"[Copy Buy] At max concurrent positions ({len(self.active_monitors)}). Skipping buy for {symbol}.")
                return
                
            # Check if we already have an active position
            if token_addr_lower in self.active_monitors:
                print(f"[Copy Buy] Position in {symbol} already exists. Skipping.")
                return
                
            # Whale Alpha Performance Filter: skip underperforming copy sources
            perf_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "wallet_performance.json")
            if os.path.exists(perf_file):
                try:
                    with open(perf_file, "r") as f:
                        perf_db = json.load(f)
                        wallet_record = perf_db.get(from_addr.lower())
                        if wallet_record and wallet_record.get("total_trades", 0) >= 3:
                            win_rate = wallet_record.get("win_rate", 100.0)
                            if win_rate < 45.0:
                                print(f"[Copy Buy] Skipping copy buy for {symbol}. Trigger wallet {label} ({from_addr[:6]}...) has low win rate ({win_rate:.1f}% across {wallet_record['total_trades']} trades).")
                                return
                except Exception as e:
                    print(f"[Copy Buy] Error reading wallet performance database: {e}")

            self.send_alert(f"🚀 *COPY TRADE TRIGGERED: BUY {symbol}*\nFollowing wallet: *{label}*")
            
            # Price Spike Chase Protection (FOMO skip)
            m5_change = float(pair_data.get("priceChange", {}).get("m5", 0.0)) if pair_data else 0.0
            if m5_change > 40.0:
                print(f"[Copy Buy] Price has spiked +{m5_change:.1f}% in the last 5m. Skipping fomo entry for {symbol} to wait for pullback.")
                return

            # Calculate conviction sizing
            score, stop_loss_mult = self.optimizer.evaluate_conviction(token_addr_lower, pair_data)
            score_label = "HIGH CONVICTION 🔥" if score >= 80 else "MEDIUM CONVICTION 📈" if score >= 50 else "LOW CONVICTION 💤"
            
            w3 = self.scanner.w3
            weth_contract = w3.eth.contract(
                address=w3.to_checksum_address(config.WETH_ADDRESS),
                abi=self.scanner.erc20_abi
            )
            weth_bal = w3.from_wei(weth_contract.functions.balanceOf(self.trader.address).call(), 'ether')
            
            standard_size_eth = float(weth_bal) * (getattr(config, "BASE_TRADE_SIZE_PCT", 15.0) / 100.0)
            standard_size_eth = min(standard_size_eth, getattr(config, "MAX_TRADE_AMOUNT_ETH", 0.05))
            sizing_eth = max(standard_size_eth, config.TRADE_AMOUNT_ETH) # Floor fallback
            
            # Apply Risk Parity sizing based on stop-loss width
            expected_loss_pct = 1.0 - stop_loss_mult
            if expected_loss_pct > 0:
                standard_loss_pct = 0.15 # standard 15% stop-loss reference
                scale_factor = standard_loss_pct / expected_loss_pct
                sizing_eth = sizing_eth * scale_factor
                print(f"[Risk Parity] Scaled sizing by {scale_factor:.2f}x to {sizing_eth:.6f} ETH due to {expected_loss_pct*100:.0f}% stop-loss width.")

            min_floor = getattr(config, "MIN_TRADING_BALANCE_ETH", 0.0015)
            if sizing_eth < min_floor and weth_bal >= min_floor:
                sizing_eth = min_floor
                
            if sizing_eth > weth_bal * 0.95:
                sizing_eth = weth_bal * 0.95
                
            if sizing_eth < 0.0005:
                print(f"[Copy Buy] Sizing {sizing_eth:.6f} ETH is below absolute minimum. Skipping.")
                return
                
            # Ensure native gas is sufficient
            native_bal = w3.from_wei(w3.eth.get_balance(self.trader.address), 'ether')
            if native_bal < 0.0001:
                print(f"[Copy Buy] Native gas balance {native_bal:.6f} ETH is too low. Skipping.")
                return
                
            amount_in_wei = int(sizing_eth * 10**18)
            
            # Swap execution
            labels = pair_data.get("labels", []) if pair_data else []
            dex_version = 'v2' if 'v2' in labels else 'v3'
            pool_fee = 10000
            p = pair_data.get("pairAddress", "") if pair_data else None
            
            # Resolve pool for v3 dynamically if needed
            if dex_version == 'v3':
                factory_abi = [{"inputs": [{"name": "tokenA", "type": "address"}, {"name": "tokenB", "type": "address"}, {"name": "fee", "type": "uint24"}], "name": "getPool", "outputs": [{"name": "", "type": "address"}], "type": "function"}]
                factory = w3.eth.contract(address=w3.to_checksum_address(config.UNISWAP_V3_FACTORY), abi=factory_abi)
                for fee in [10000, 3000, 500]:
                    try:
                        p_addr = factory.functions.getPool(w3.to_checksum_address(token_addr), w3.to_checksum_address(config.WETH_ADDRESS), fee).call()
                        if p_addr and p_addr != "0x0000000000000000000000000000000000000000":
                            p = p_addr
                            pool_fee = fee
                            break
                    except:
                        continue

            # Audit token buy tax before executing swap
            if p:
                if not self.verify_token_tax_safety(token_addr_lower, p, symbol, dex_version=dex_version):
                    return

            min_out = self.calculate_slippage_limit(token_addr_lower, amount_in_wei, is_buy=True, pair_data=pair_data)
            
            buy_success = False
            if config.TRADE_EXECUTION_ENABLED:
                buy_success = self.trader.execute_swap(
                    token_in=config.WETH_ADDRESS,
                    token_out=token_addr_lower,
                    amount_in=amount_in_wei,
                    pool_fee=pool_fee,
                    amount_out_minimum=min_out,
                    dex_version=dex_version
                )
            else:
                buy_success = True
                
            if buy_success:
                eth_pair = self.tracker.fetch_dex_stats("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2")
                eth_price = float(eth_pair.get("priceUsd", 1800.0)) if eth_pair else 1800.0
                entry_price = float(pair_data.get("priceUsd", 0)) if pair_data else 0.0001
                
                if p:
                    try:
                        onchain = self.get_onchain_price(token_addr_lower, config.WETH_ADDRESS, p, dex_version=dex_version)
                        if onchain > 0.0:
                            entry_price = onchain * eth_price
                    except:
                        pass
                        
                # Register active monitor position
                self.active_monitors[token_addr_lower] = {
                    'symbol': symbol,
                    'name': name,
                    'entry_price': entry_price,
                    'highest_price': entry_price,
                    'buy_time': time.time(),
                    'token_balance': amount_in_wei, # simplified/estimated for simulation
                    'stop_loss_mult': stop_loss_mult,
                    'tp_stage': 0,
                    'dex_version': dex_version,
                    'pool_fee': pool_fee,
                    'pool_address': p,
                    'copy_traded': True,
                    'copied_from': label,
                    'trigger_wallet_address': from_addr.lower()
                }
                self.save_active_positions()
                
                # Fetch actual balance if trading was live
                if config.TRADE_EXECUTION_ENABLED:
                    try:
                        token_contract = w3.eth.contract(address=w3.to_checksum_address(token_addr), abi=self.scanner.erc20_abi)
                        actual_bal = token_contract.functions.balanceOf(self.trader.address).call()
                        if actual_bal > 0:
                            self.active_monitors[token_addr_lower]['token_balance'] = actual_bal
                            self.save_active_positions()
                    except:
                        pass
                        
                self.send_alert(
                    f"✅ *SUCCESSFULLY BOUGHT {symbol} (COPY-TRADE)*\n"
                    f"• Entry Price: ${entry_price:.8f}\n"
                    f"• Sizing: {sizing_eth:.6f} ETH\n"
                    f"• Copied From: *{label}*"
                )
        except Exception as e:
            print(f"[Copy Buy] Error executing copy buy: {str(e)}")
            traceback.print_exc()

    async def execute_copy_sell(self, token_addr, symbol, label):
        """Executes a copy trade sell swap to mirror exit from a smart money wallet"""
        try:
            token_addr_lower = token_addr.lower()
            if token_addr_lower not in self.active_monitors:
                return
                
            monitored_data = self.active_monitors[token_addr_lower]
            self.send_alert(f"🚨 *COPY TRADE EXIT TRIGGERED: SELL {symbol}*\nFollowing wallet exit: *{label}*")
            
            w3 = self.scanner.w3
            token_contract = w3.eth.contract(address=w3.to_checksum_address(token_addr), abi=self.scanner.erc20_abi)
            token_bal = token_contract.functions.balanceOf(self.trader.address).call()
            
            # In simulation, fallback to registered balance
            if token_bal == 0:
                token_bal = monitored_data.get('token_balance', 0)
                
            if token_bal == 0:
                self.send_alert(f"❌ Balance is 0. Removing position monitor.")
                del self.active_monitors[token_addr_lower]
                self.save_active_positions()
                return
                
            pair_data = self.tracker.fetch_dex_stats(token_addr_lower)
            labels = pair_data.get("labels", []) if pair_data else []
            dex_version = monitored_data.get('dex_version', 'v3')
            pool_fee = monitored_data.get('pool_fee', 10000)
            
            min_out = self.calculate_slippage_limit(token_addr_lower, token_bal, is_buy=False, pair_data=pair_data)
            
            sell_success = False
            if config.TRADE_EXECUTION_ENABLED:
                sell_success = self.trader.execute_swap(
                    token_in=w3.to_checksum_address(token_addr),
                    token_out=config.WETH_ADDRESS,
                    amount_in=token_bal,
                    pool_fee=pool_fee,
                    amount_out_minimum=min_out,
                    dex_version=dex_version
                )
            else:
                sell_success = True
                
            if sell_success:
                eth_pair = self.tracker.fetch_dex_stats("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2")
                eth_price = float(eth_pair.get("priceUsd", 1800.0)) if eth_pair else 1800.0
                exit_price = float(pair_data.get("priceUsd", 0)) if pair_data else 0.0
                
                # Resolve on-chain if possible
                pool_addr = monitored_data.get('pool_address')
                if pool_addr:
                    try:
                        onchain = self.get_onchain_price(token_addr_lower, config.WETH_ADDRESS, pool_addr, dex_version=dex_version)
                        if onchain > 0.0:
                            exit_price = onchain * eth_price
                    except:
                        pass
                        
                self.log_closed_position(token_addr_lower, exit_price, "copy_trade_exit")
                del self.active_monitors[token_addr_lower]
                self.save_active_positions()
                
                self.send_alert(
                    f"✅ *SUCCESSFULLY EXITED {symbol} (COPY-TRADE EXIT)*\n"
                    f"• Exit Price: ${exit_price:.8f}\n"
                    f"• Copied From Wallet Exit: *{label}*"
                )
        except Exception as e:
            print(f"[Copy Sell] Error executing copy sell: {str(e)}")
            traceback.print_exc()

    def load_active_positions(self):
        """Load saved active positions from local active_positions.json"""
        import sys
        if "--simulate" in sys.argv:
            return
        import os
        import json
        json_path = os.path.join(os.path.dirname(__file__), 'active_positions.json')
        if os.path.exists(json_path):
            try:
                with open(json_path, 'r') as f:
                    self.active_monitors = json.load(f)
                    print(f"[Bot] Loaded {len(self.active_monitors)} active positions from registry.")
            except Exception as e:
                print(f"[Bot] Error loading active_positions.json: {str(e)}")

    def save_active_positions(self):
        """Save active positions to local active_positions.json"""
        import sys
        if "--simulate" in sys.argv:
            return
        import os
        import json
        json_path = os.path.join(os.path.dirname(__file__), 'active_positions.json')
        try:
            with open(json_path, 'w') as f:
                json.dump(self.active_monitors, f, indent=2)
            self.copy_to_public(json_path, 'active_positions.json')
        except Exception as e:
            print(f"[Bot] Error saving active_positions.json: {str(e)}")

    def load_watchlist(self):
        """Load watchlist tokens from local watchlist.json"""
        import os
        import json
        if os.path.exists(self.watchlist_file):
            try:
                with open(self.watchlist_file, 'r') as f:
                    self.watchlist = json.load(f)
                    print(f"[Bot] Loaded {len(self.watchlist)} watchlist tokens.")
            except Exception as e:
                print(f"[Bot] Error loading watchlist.json: {str(e)}")

    def save_watchlist(self):
        """Save watchlist tokens to local watchlist.json"""
        import json
        try:
            with open(self.watchlist_file, 'w') as f:
                json.dump(self.watchlist, f, indent=2)
        except Exception as e:
            print(f"[Bot] Error saving watchlist.json: {str(e)}")

    async def send_periodic_summary(self):
        """Send 10-minute updates of all active monitors or a heartbeat status if empty"""
        if not self.active_monitors:
            heartbeat_msg = (
                f"🟢 *HEARTBEAT: SCANNER ACTIVE*\n"
                f"-----------------------------------------\n"
                f"▪️ No new launches detected in the last 10 minutes.\n"
                f"▪️ Active monitors: 0\n"
                f"-----------------------------------------\n"
                f"🔍 Listening for Robinhood Chain deployments..."
            )
            self.send_alert(heartbeat_msg)
            return

        lines = []
        for addr, data in self.active_monitors.items():
            pair_data = self.tracker.fetch_dex_stats(addr)
            price_str = "Unknown"
            vol_str = "Unknown"
            mult_str = f"{data['max_mult']:.1f}x"
            
            if pair_data:
                price = float(pair_data.get("priceUsd", 0))
                volume = float(pair_data.get("volume", {}).get("m5", 0))
                price_str = f"${price:.8f}"
                vol_str = f"${volume:,.2f}"
                
                initial_price = data['prices'][0]
                mult = price / initial_price if initial_price > 0 else 1.0
                mult_str = f"{mult:.1f}x"

            lines.append(f"▪️ *{data['symbol']}*: {price_str} ({mult_str} from entry) | 5m Vol: {vol_str}")

        summary_msg = (
            f"📊 *ACTIVE RUNNER SUMMARY (10M UPDATE)*\n"
            f"-----------------------------------------\n"
            + "\n".join(lines) + "\n"
            f"-----------------------------------------\n"
            f"🟢 Scan active. Monitoring L2 block events..."
        )
        self.send_alert(summary_msg)

    def send_alert(self, message):
        """Send formatted markdown message to both Telegram and Discord channels"""
        print(f"[Alert Dispatch]:\n{message}\n")
        self.send_telegram_alert(message)
        self.send_discord_alert(message)

    def send_telegram_alert(self, message):
        if config.TELEGRAM_BOT_TOKEN == "YOUR_BOT_TOKEN_HERE" or config.TELEGRAM_CHAT_ID == "YOUR_CHAT_ID_HERE":
            return
        url = f"https://api.telegram.org/bot{config.TELEGRAM_BOT_TOKEN}/sendMessage"
        payload = {
            "chat_id": config.TELEGRAM_CHAT_ID,
            "text": message,
            "parse_mode": "Markdown",
            "disable_web_page_preview": True
        }
        try:
            requests.post(url, json=payload, timeout=5)
        except Exception as e:
            print(f"[Telegram] Failed to send alert: {str(e)}")

    def send_discord_alert(self, message):
        if config.DISCORD_WEBHOOK_URL == "YOUR_DISCORD_WEBHOOK_HERE" or not config.DISCORD_WEBHOOK_URL:
            return
        
        # Clean up any Telegram specific markdown formatting that Discord doesn't support
        clean_msg = message.replace("▪️", "•")
        payload = {
            "content": clean_msg
        }
        try:
            res = requests.post(config.DISCORD_WEBHOOK_URL, json=payload, timeout=5)
            if res.status_code not in [200, 204]:
                print(f"[Discord] Webhook returned status: {res.status_code}, content: {res.text}")
        except Exception as e:
            print(f"[Discord] Failed to send webhook: {str(e)}")

    def format_launch_alert(self, token_address, name, symbol, lp_usd, renounced, locked, tier, sizing_eth, tp_target):
        lock_emoji = "🔒 LOCKED" if locked else "⚠️ UNLOCKED (HIGH RISK)"
        renounce_emoji = "✅ RENOUNCED" if renounced else "⚠️ NOT RENOUNCED (DEV CAN MINT)"
        tier_str = "🔥 Tier 1 (High Conviction - Primed Play 🚀)" if tier == 1 else "⚖️ Tier 2 (Standard Play)"
        
        return (
            f"🚀 *NEW ROBINHOOD CHAIN RUNNER DETECTED*\n"
            f"-----------------------------------------\n"
            f"▪️ *Token:* {name} ({symbol})\n"
            f"▪️ *Address:* `{token_address}`\n"
            f"▪️ *Initial Liquidity:* ${lp_usd:,.2f}\n"
            f"-----------------------------------------\n"
            f"🛡️ *Security Analysis:*\n"
            f"▪️ *LP status:* {lock_emoji}\n"
            f"▪️ *Contract status:* {renounce_emoji}\n"
            f"▪️ *Conviction Tier:* {tier_str}\n"
            f"-----------------------------------------\n"
            f"💸 *Execution Plan:*\n"
            f"▪️ *Buy Sizing:* {sizing_eth} ETH\n"
            f"▪️ *De-risk Exit:* {tp_target}x\n"
            f"-----------------------------------------\n"
            f"📈 [DexScreener Link](https://dexscreener.com/robinhood/{token_address})"
        )

    def format_momentum_alert(self, token_address, symbol, current_price, vol_roc, velocity):
        return (
            f"🔥 *GAIN MOMENTUM: {symbol} RUNNING*\n"
            f"-----------------------------------------\n"
            f"▪️ *Token:* {symbol}\n"
            f"▪️ *Velocity:* {velocity} trades/hour (High)\n"
            f"▪️ *Volume ROC (5m):* +{vol_roc:.1f}%\n"
            f"▪️ *Price:* ${current_price:.8f}\n"
            f"-----------------------------------------\n"
            f"✅ *Dips bought back rapidly. Insider concentration is low.*"
        )

    def format_exit_alert(self, symbol, signals, p_l_pct):
        signals_list = "\n".join([f"▪️ {sig}" for sig in signals])
        p_l_sign = "+" if p_l_pct >= 0 else ""
        return (
            f"🚨 *EXIT SIGNAL: CLOSED POSITION ON {symbol}*\n"
            f"-----------------------------------------\n"
            f"⚠️ *Exhaustion Flags:* \n"
            f"{signals_list}\n"
            f"-----------------------------------------\n"
            f"📈 *Trade Performance:* {p_l_sign}{p_l_pct:.2f}%\n"
            f"-----------------------------------------\n"
            f"🎯 *Run is losing support. Position closed.*"
        )

    def is_scam_or_duplicate(self, token_addr, name, symbol):
        """Analyze name, symbol, and contract address to prevent buying copycats and spam rugs"""
        addr_lower = token_addr.lower()
        name_lower = name.lower()
        sym_lower = symbol.lower()
        
        # 1. Spam / Rug keywords check
        blacklist_words = ["seed", "spam", "test", "mock", "rug", "cheat", "dummy", "scam", "fake", "honeypot", "temp", "developer", "deployer", "hoodrat"]
        for word in blacklist_words:
            if word in name_lower or word in sym_lower:
                return True, f"Banned keyword '{word}' detected in name/symbol"
                
        # 2. Verified tokens list (Known established tokens)
        # If a token has one of these symbols, it MUST match the verified contract address.
        # Otherwise, it's a malicious mimic/copycat coin.
        verified_tokens = {
            "weth": "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
            "usdc": "0x2e8a10e75529ba765768113b7b5670327e8f7eeb",
            "hoodrat": "0x8e62f281f282686fca6dcb39288069a93fc23f1c",
            "wallet": "0x0339f5459fc690ac85f1782e15782a151b4a9e1b",
            "cashcat": "0x020bfc650a365f8bb26819deaabf3e21291018b4",
            "databear": "0x90079857237da767c38d1d261a39848ea424319e",
            "juggernaut": "0xd7321801caae694090694ff55a9323139f043b88",
            "530a": "0x6e47d95928cb39b5e51be425aab2a5190418e943",
            "noxa": "0x39e0d9057bd9039cd14590f54de20b9d3457c56e",
            "fox": "0x32758ae8e02b0a2cb6b802b6aaeaf74158c169f7",
            "suit": "0x262a5dd97aa17fe9815623707f98c7b0ba95b476",
            "bottomless": "0xcf1d3f2a210a255a7220f8d5aab4162f99eded65"
        }
        
        if sym_lower in verified_tokens:
            if addr_lower != verified_tokens[sym_lower]:
                return True, f"Mimic/Copycat token of established symbol '{symbol.upper()}' (Address mismatch)"
                
        # 3. Dynamic check against trade history and watchlist to block symbol duplicates
        try:
            history_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "trade_history.json")
            if os.path.exists(history_file):
                with open(history_file, 'r') as f:
                    history = json.load(f)
                    for trade in history:
                        if trade.get('symbol', '').lower() == sym_lower:
                            trade_addr = trade.get('address', '').lower()
                            if trade_addr and trade_addr != addr_lower:
                                return True, f"Duplicate symbol '{symbol.upper()}' of previously traded token at '{trade_addr}'"
        except Exception as e:
            print(f"[Scam Filter] Error checking history: {str(e)}")
            
        try:
            if hasattr(self, 'watchlist') and self.watchlist:
                for addr, item in self.watchlist.items():
                    if item.get('symbol', '').lower() == sym_lower:
                        if addr.lower() != addr_lower:
                            return True, f"Duplicate symbol '{symbol.upper()}' of watchlisted token at '{addr}'"
        except Exception as e:
            print(f"[Scam Filter] Error checking watchlist: {str(e)}")
            
        return False, ""

    def check_circuit_breaker(self):
        """Verify if total losses in the last 24 hours exceed daily limit"""
        try:
            history_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "trade_history.json")
            if not os.path.exists(history_file):
                return False, 0.0
                
            now = time.time()
            day_seconds = 24 * 3600
            losses_usd = 0.0
            gains_usd = 0.0
            
            with open(history_file, 'r') as f:
                history = json.load(f)
                for trade in history:
                    trade_time = trade.get('timestamp', 0)
                    if now - trade_time <= day_seconds:
                        pl_usd = float(trade.get('p_l_usd', 0.0))
                        gas_usd = float(trade.get('total_gas_usd', 0.0))
                        net_trade_pl_usd = pl_usd - gas_usd
                        if net_trade_pl_usd < 0:
                            losses_usd += abs(net_trade_pl_usd)
                        else:
                            gains_usd += net_trade_pl_usd
            
            current_portfolio_usd = self.get_total_portfolio_usd()
            total_cap_usd = current_portfolio_usd + losses_usd - gains_usd
            
            if total_cap_usd <= 0:
                return False, 0.0
                
            net_daily_loss = losses_usd - gains_usd
            if net_daily_loss > 0:
                loss_pct = (net_daily_loss / total_cap_usd) * 100.0
                if loss_pct >= config.CIRCUIT_BREAKER_DAILY_LOSS_PCT:
                    return True, loss_pct
            return False, 0.0
        except Exception as e:
            print(f"[Circuit Breaker] Error checking daily P&L: {str(e)}")
            return False, 0.0

    def get_total_portfolio_usd(self):
        """Calculate the total current portfolio value in USD (WETH + ETH + active positions value)"""
        try:
            w3 = self.scanner.w3
            
            # 1. Fetch balances
            eth_bal = float(w3.from_wei(w3.eth.get_balance(self.trader.address), 'ether'))
            
            weth_contract = w3.eth.contract(
                address=w3.to_checksum_address(config.WETH_ADDRESS),
                abi=self.scanner.erc20_abi
            )
            weth_bal = float(w3.from_wei(weth_contract.functions.balanceOf(self.trader.address).call(), 'ether'))
            
            # 2. Fetch WETH price
            eth_price = 1784.0
            try:
                eth_pair = self.tracker.fetch_dex_stats("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2")
                if eth_pair:
                    eth_price = float(eth_pair.get("priceUsd", 1784.0))
            except Exception as e:
                print(f"[Drawdown] Error fetching ETH price: {str(e)}")

            # 3. Calculate active positions value in WETH
            active_val_weth = 0.0
            self.load_active_positions()
            for addr, pos in self.active_monitors.items():
                try:
                    entry_size_eth = float(pos.get("entry_size_eth", 0.005))
                    entry_price = float(pos.get("entry_price", 0.0))
                    prices = pos.get("prices", [])
                    current_price = float(prices[-1]) if prices else entry_price
                    ratio = current_price / entry_price if entry_price > 0 else 1.0
                    active_val_weth += entry_size_eth * ratio
                except Exception as ex:
                    print(f"[Drawdown] Error evaluating active pos {pos.get('symbol')}: {str(ex)}")

            total_weth = weth_bal + eth_bal + active_val_weth
            return total_weth * eth_price
        except Exception as e:
            print(f"[Drawdown] Error calculating portfolio USD: {str(e)}")
            return 0.0

    def get_total_portfolio_eth(self):
        """Calculate the total current portfolio value in native ETH (WETH + ETH + active positions value in WETH)"""
        try:
            w3 = self.scanner.w3
            
            # 1. Fetch balances
            eth_bal = float(w3.from_wei(w3.eth.get_balance(self.trader.address), 'ether'))
            
            weth_contract = w3.eth.contract(
                address=w3.to_checksum_address(config.WETH_ADDRESS),
                abi=self.scanner.erc20_abi
            )
            weth_bal = float(w3.from_wei(weth_contract.functions.balanceOf(self.trader.address).call(), 'ether'))
            
            # 2. Calculate active positions value in WETH
            active_val_weth = 0.0
            self.load_active_positions()
            for addr, pos in self.active_monitors.items():
                try:
                    entry_size_eth = float(pos.get("entry_size_eth", 0.005))
                    entry_price = float(pos.get("entry_price", 0.0))
                    prices = pos.get("prices", [])
                    current_price = float(prices[-1]) if prices else entry_price
                    ratio = current_price / entry_price if entry_price > 0 else 1.0
                    active_val_weth += entry_size_eth * ratio
                except Exception as ex:
                    print(f"[Drawdown] Error evaluating active pos {pos.get('symbol')}: {str(ex)}")

            return weth_bal + eth_bal + active_val_weth
        except Exception as e:
            print(f"[Drawdown] Error calculating portfolio ETH: {str(e)}")
            return 0.0

    def evaluate_market_recovery(self):
        """
        Evaluate if market conditions have improved enough to warrant lifting the lockout.
        Criteria:
        1. If the portfolio value has bounced back to within 5% of today's daily peak (in ETH).
        """
        try:
            import os
            import json
            
            # Check if portfolio value has recovered to within 5% of peak (now in ETH)
            state_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "daily_state.json")
            if os.path.exists(state_file):
                try:
                    with open(state_file, 'r') as f:
                        state = json.load(f)
                    peak = state.get("daily_peak_eth", 0.0)
                    current = self.get_total_portfolio_eth()
                    if peak > 0.0 and current > 0.0:
                        drawdown = ((peak - current) / peak) * 100.0
                        if drawdown <= 5.0:
                            print(f"[Market Recovery] Portfolio recovered to {current:.6f} ETH (only {drawdown:.1f}% drawdown).")
                            return True
                except Exception as e:
                    print(f"[Market Recovery] Error checking state file: {e}")

        except Exception as e:
            print(f"[Market Recovery] Error evaluating recovery: {e}")
        return False

    def get_token_tax(self, token_address, pool_address, dex_version='v3'):
        """
        Query the last swap on-chain in this pool, and calculate buy tax
        by comparing pool swap output to token transfer value.
        """
        try:
            w3 = self.scanner.w3
            v3_swap_sig = w3.keccak(text="Swap(address,address,int256,int256,uint160,uint128,int24)").hex()
            v2_swap_sig = w3.keccak(text="Swap(address,uint256,uint256,uint256,uint256,address)").hex()
            transfer_sig = w3.keccak(text="Transfer(address,address,uint256)").hex()
            
            # Fetch last 200 blocks of logs for this pool address
            current_block = w3.eth.block_number
            logs = w3.eth.get_logs({
                "address": w3.to_checksum_address(pool_address),
                "fromBlock": max(1, current_block - 200),
                "toBlock": "latest"
            })
            
            if not logs:
                return 0.0
                
            # Find the most recent Swap log
            swap_log = None
            for log in reversed(logs):
                if log.get("topics", []) and log["topics"][0].hex() in [v3_swap_sig, v2_swap_sig]:
                    swap_log = log
                    break
                    
            if not swap_log:
                return 0.0
                
            tx_hash = swap_log["transactionHash"]
            receipt = w3.eth.get_transaction_receipt(tx_hash)
            
            # Find the Swap event log inside the receipt
            target_swap_log = None
            for log in receipt.get("logs", []):
                if log["address"].lower() == pool_address.lower() and log.get("topics", []) and log["topics"][0].hex() in [v3_swap_sig, v2_swap_sig]:
                    target_swap_log = log
                    break
                    
            if not target_swap_log:
                return 0.0
                
            pool_output_amount = 0
            
            if target_swap_log["topics"][0].hex() == v3_swap_sig:
                data_hex = target_swap_log["data"].hex() if isinstance(target_swap_log["data"], bytes) else target_swap_log["data"]
                def to_signed_int(h):
                    val = int(h, 16)
                    if val >= 2**255:
                        val -= 2**256
                    return val
                amount0 = to_signed_int(data_hex[0:64])
                amount1 = to_signed_int(data_hex[64:128])
                pool_contract = w3.eth.contract(
                    address=w3.to_checksum_address(pool_address),
                    abi=[{"inputs": [], "name": "token0", "outputs": [{"name": "", "type": "address"}], "stateMutability": "view", "type": "function"}]
                )
                token0 = pool_contract.functions.token0().call()
                if token_address.lower() == token0.lower():
                    pool_output_amount = abs(amount0) if amount0 < 0 else 0
                else:
                    pool_output_amount = abs(amount1) if amount1 < 0 else 0
            else:
                data_hex = target_swap_log["data"].hex() if isinstance(target_swap_log["data"], bytes) else target_swap_log["data"]
                amount0Out = int(data_hex[128:192], 16)
                amount1Out = int(data_hex[192:256], 16)
                pool_contract = w3.eth.contract(
                    address=w3.to_checksum_address(pool_address),
                    abi=[{"inputs": [], "name": "token0", "outputs": [{"name": "", "type": "address"}], "stateMutability": "view", "type": "function"}]
                )
                token0 = pool_contract.functions.token0().call()
                if token_address.lower() == token0.lower():
                    pool_output_amount = amount0Out
                else:
                    pool_output_amount = amount1Out
                    
            if pool_output_amount <= 0:
                return 0.0
                
            # Filter transfers of token_address in this transaction
            transfers = []
            for log in receipt.get("logs", []):
                if log["address"].lower() == token_address.lower() and log.get("topics", []) and log["topics"][0].hex() == transfer_sig:
                    val = int(log["data"].hex(), 16) if isinstance(log["data"], bytes) else int(log["data"], 16)
                    transfers.append(val)
                    
            if not transfers:
                return 0.0
                
            actual_received = max(transfers)
            
            if actual_received < pool_output_amount:
                tax_pct = (pool_output_amount - actual_received) / pool_output_amount
                return tax_pct
                
        except Exception as e:
            print(f"[Tax Oracle] Error checking tax for {token_address}: {e}")
        return 0.0

    def verify_token_tax_safety(self, token_address, pool_address, symbol, dex_version='v3'):
        """
        Verify if the token has a buy/transfer tax on-chain.
        If tax is detected above 1.5%, returns False. Otherwise True.
        """
        if not pool_address:
            return True
            
        try:
            tax_rate = self.get_token_tax(token_address, pool_address, dex_version=dex_version)
            if tax_rate > 0.015:
                print(f"[Tax Auditor] 🚨 Reverting buy for {symbol}. Token has an audited buy/transfer tax of {tax_rate*100:.1f}%, which violates zero-tax trading rules.")
                self.send_alert(
                    f"⚠️ *AUDIT REJECTED: TAX TOKEN DETECTED*\n"
                    f"-----------------------------------------\n"
                    f"• Token: {symbol}\n"
                    f"• Address: `{token_address[:10]}...`\n"
                    f"• Audited Buy Tax: {tax_rate*100:.1f}%\n"
                    f"• Decision: Skipped purchase to protect capital from starting in the red! 🛡️"
                )
                return False
        except Exception as e:
            print(f"[Tax Auditor] Error during tax audit for {symbol}: {e}")
        return True

    def check_daily_drawdown_lockout(self):
        """Update and check the daily peak portfolio value and drawdown lockout status (denominated in native ETH)"""
        try:
            import datetime
            import json
            import os
            
            state_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "daily_state.json")
            now_utc = datetime.datetime.now(datetime.timezone.utc)
            today_str = str(now_utc.date())
            
            # 1. Load existing state
            state = {}
            if os.path.exists(state_file):
                try:
                    with open(state_file, 'r') as f:
                        state = json.load(f)
                except Exception as e:
                    print(f"[Drawdown] Error reading daily_state.json: {str(e)}")

            # 2. Reset daily state at midnight
            if state.get("date") != today_str:
                state = {
                    "date": today_str,
                    "daily_peak_eth": 0.0,
                    "drawdown_lock_active": False
                }
            
            # Migrate legacy fields if they exist
            if "daily_peak_usd" in state:
                state.pop("daily_peak_usd")
            
            if state.get("drawdown_lock_active", False):
                if self.evaluate_market_recovery():
                    print("[Drawdown] 🟢 Market recovery detected! Auto-releasing lockout.")
                    state["drawdown_lock_active"] = False
                    try:
                        with open(state_file, 'w') as f:
                            json.dump(state, f, indent=2)
                    except Exception as se:
                        print(f"[Drawdown] Error saving released state: {se}")
                    self.send_alert(
                        "🟢 *DRAWDOWN LOCKOUT AUTO-RELEASED*\n"
                        "-----------------------------------------\n"
                        "• Reason: Portfolio value recovered near peak.\n"
                        "• Action: Re-enabled all buy operations and copy-trading trackers! 🚀"
                    )
                    return False
                return True # Locked out

            # 3. Query current portfolio value in native ETH
            current_val = self.get_total_portfolio_eth()
            if current_val <= 0.0:
                return False # Ignore temporary query errors

            # 4. Update daily peak
            if current_val > state.get("daily_peak_eth", 0.0):
                state["daily_peak_eth"] = current_val
                print(f"[Drawdown] New Daily Peak ETH set: {current_val:.6f} ETH")

            # 5. Check drawdown threshold from peak
            peak = state["daily_peak_eth"]
            if peak > 0.0:
                drawdown_pct = ((peak - current_val) / peak) * 100.0
                if drawdown_pct >= config.MAX_DAILY_DRAWDOWN_PCT:
                    state["drawdown_lock_active"] = True
                    print(f"[Drawdown] 🚨 Peak-to-Trough Lockout Triggered! Peak: {peak:.6f} ETH, Current: {current_val:.6f} ETH ({drawdown_pct:.1f}% Drawdown)")
                    self.send_alert(
                        f"🚨 *DAILY DRAWDOWN LIMIT HIT!*\n"
                        f"-----------------------------------------\n"
                        f"• Today's Peak Value: {peak:.6f} ETH\n"
                        f"• Current Portfolio Value: {current_val:.6f} ETH\n"
                        f"• Drawdown: -{drawdown_pct:.1f}% (Limit: {config.MAX_DAILY_DRAWDOWN_PCT}%)\n"
                        f"• Action: Locking all new auto-buys until midnight to lock in today's gains! 🔒"
                    )

            # 6. Save updated state to disk
            try:
                with open(state_file, 'w') as f:
                    json.dump(state, f, indent=2)
            except Exception as e:
                print(f"[Drawdown] Error writing daily_state.json: {str(e)}")

            return state.get("drawdown_lock_active", False)
        except Exception as e:
            print(f"[Drawdown] Error checking daily drawdown: {str(e)}")
            return False

    def calculate_conviction_score(self, pair_data):
        """
        Evaluate real-time indicators of the coin to return a Conviction Score (0-100).
        Indicators assessed:
        - Volume-to-Liquidity Ratio (Mo/Liq) [30 points]
        - Short-term Momentum congruence (5m, 15m, 1h change) [40 points]
        - Transaction Velocity (5m & 1h trade count) [30 points]
        """
        try:
            if not pair_data:
                return 40 # Default to conservative low score if API fails
                
            score = 0
            
            # 1. Volume-to-Liquidity (Mo/Liq) Ratio [Max 30 points]
            # Indicates active capital flow relative to slippage depth
            liquidity = float(pair_data.get("liquidity", {}).get("usd", 0.0) or 0.0)
            vol_5m = float(pair_data.get("volume", {}).get("m5", 0.0) or 0.0)
            vol_1h = float(pair_data.get("volume", {}).get("h1", 0.0) or 0.0)
            
            if liquidity > 0:
                ratio_5m = (vol_5m / liquidity) * 100.0
                ratio_1h = (vol_1h / liquidity) * 100.0
                
                # Up to 15 points for 5m volume ratio (high relative interest)
                if ratio_5m >= 10.0: score += 15
                elif ratio_5m >= 5.0: score += 10
                elif ratio_5m >= 2.0: score += 5
                
                # Up to 15 points for 1h volume ratio
                if ratio_1h >= 50.0: score += 15
                elif ratio_1h >= 25.0: score += 10
                elif ratio_1h >= 10.0: score += 5
            
            # 2. Short-term Momentum congruence [Max 40 points]
            change_5m = float(pair_data.get("priceChange", {}).get("m5", 0.0) or 0.0)
            change_15m = float(pair_data.get("priceChange", {}).get("m15", 0.0) or 0.0)
            change_1h = float(pair_data.get("priceChange", {}).get("h1", 0.0) or 0.0)
            
            # Short term pumping (5m change) [Max 15 pts]
            if 5.0 <= change_5m <= 30.0: score += 15  # Good entry momentum
            elif 2.0 <= change_5m < 5.0: score += 10
            elif -5.0 <= change_5m < 2.0: score += 5   # Consolidation/retest
            
            # 15m change [Max 15 pts]
            if 10.0 <= change_15m <= 50.0: score += 15
            elif 5.0 <= change_15m < 10.0: score += 10
            elif 0.0 <= change_15m < 5.0: score += 5
            
            # 1h change [Max 10 pts]
            if change_1h >= 15.0: score += 10
            elif change_1h >= 0.0: score += 5
            
            # 3. Transaction Velocity [Max 30 points]
            tx_5m = int(pair_data.get("txns", {}).get("m5", {}).get("buys", 0) or 0) + \
                    int(pair_data.get("txns", {}).get("m5", {}).get("sells", 0) or 0)
            tx_1h = int(pair_data.get("txns", {}).get("h1", {}).get("buys", 0) or 0) + \
                    int(pair_data.get("txns", {}).get("h1", {}).get("sells", 0) or 0)
            
            # 5m velocity [Max 15 pts]
            if tx_5m >= 15: score += 15
            elif tx_5m >= 8: score += 10
            elif tx_5m >= 3: score += 5
            
            # 1h velocity [Max 15 pts]
            if tx_1h >= 120: score += 15
            elif tx_1h >= 60: score += 10
            elif tx_1h >= 20: score += 5
            
            # Ensure return is bounded
            return min(100, max(0, score))
        except Exception as e:
            print(f"[Conviction] Error scoring token: {str(e)}")
            return 40 # Default to conservative low score if calculation errors out

    def check_daily_profit_goal(self):
        """Verify if net gains in the current calendar day (UTC) meet or exceed the target daily goal"""
        try:
            history_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "trade_history.json")
            if not os.path.exists(history_file):
                return False, 0.0
                
            import datetime
            now_utc = datetime.datetime.now(datetime.timezone.utc)
            today_date = now_utc.date()
            
            settled_losses_usd = 0.0
            settled_gains_usd = 0.0
            
            with open(history_file, 'r') as f:
                history = json.load(f)
                for trade in history:
                    trade_time = trade.get('timestamp', 0)
                    trade_utc = datetime.datetime.fromtimestamp(trade_time, datetime.timezone.utc)
                    if trade_utc.date() == today_date:
                        pl_usd = float(trade.get('p_l_usd', 0.0))
                        gas_usd = float(trade.get('total_gas_usd', 0.0))
                        net_trade_pl_usd = pl_usd - gas_usd
                        if net_trade_pl_usd < 0:
                            settled_losses_usd += abs(net_trade_pl_usd)
                        else:
                            settled_gains_usd += net_trade_pl_usd
            
            current_portfolio_usd = self.get_total_portfolio_usd()
            total_cap_usd = current_portfolio_usd + settled_losses_usd - settled_gains_usd
            
            if total_cap_usd <= 0:
                return False, 0.0
                
            net_daily_gain = settled_gains_usd - settled_losses_usd
            if net_daily_gain > 0:
                gain_pct = (net_daily_gain / total_cap_usd) * 100.0
                target_pct = getattr(config, "DAILY_PROFIT_GOAL_PCT", 50.0)
                if gain_pct >= target_pct:
                    return True, gain_pct
            return False, 0.0
        except Exception as e:
            print(f"[Profit Goal] Error checking daily profit: {str(e)}")
            return False, 0.0

    def process_pool_log(self, log):
        """Parse Uniswap V3 PoolCreated log details to check for new runners"""
        try:
            # Extract token0 and token1 from topics
            t0 = "0x" + log['topics'][1].hex()[-40:]
            t1 = "0x" + log['topics'][2].hex()[-40:]
            pool_addr = "0x" + log['data'].hex()[-40:]
            
            # Fetch metadata to dynamically identify base vs meme token
            name0, sym0, supply0 = self.scanner.get_token_metadata(t0)
            name1, sym1, supply1 = self.scanner.get_token_metadata(t1)
            
            base_symbols = ["WETH", "USDC", "USDT", "USDG", "WETH9", "ETH", "USDC.E", "WETH.E"]
            
            if sym0.upper() in base_symbols:
                token_addr = t1
                name, symbol, supply = name1, sym1, supply1
                base_addr = t0
                base_sym = sym0
            elif sym1.upper() in base_symbols:
                token_addr = t0
                name, symbol, supply = name0, sym0, supply0
                base_addr = t1
                base_sym = sym1
            else:
                # Skip if it is meme-to-meme pool with no standard base liquidity
                return
                
            # Check for scam/duplicate tokens
            is_scam, scam_reason = self.is_scam_or_duplicate(token_addr, name, symbol)
            if is_scam:
                print(f"[Bot] Discarded potential scam/duplicate: {name} ({symbol}) at `{token_addr}`. Reason: {scam_reason}")
                return
                
            print(f"[Scanner] Discovered new pool token: {name} ({symbol}) at `{token_addr}`")
            
            # Fetch liquidity. Fallback to direct on-chain balance query if DexScreener hasn't indexed yet
            lp_usd = 0.0
            pair_data = self.tracker.fetch_dex_stats(token_addr)
            if pair_data:
                lp_usd = float(pair_data.get("liquidity", {}).get("usd", 0))
            
            # On-chain LP fallback check
            if lp_usd == 0.0:
                try:
                    w3 = self.scanner.w3
                    base_contract = w3.eth.contract(address=w3.to_checksum_address(base_addr), abi=self.scanner.erc20_abi)
                    # Resolve decimals for USDC vs WETH
                    decimals = 6 if "USDC" in base_sym.upper() or "USDT" in base_sym.upper() else 18
                    base_balance = base_contract.functions.balanceOf(w3.to_checksum_address(pool_addr)).call()
                    base_formatted = base_balance / (10 ** decimals)
                    
                    # Assume ETH price is ~$3,500 for L2 LP estimation
                    if "USDC" in base_sym.upper() or "USDT" in base_sym.upper() or "USDG" in base_sym.upper():
                        lp_usd = base_formatted * 2.0
                    else:
                        lp_usd = base_formatted * 3500.0 * 2.0
                        
                    print(f"[Scanner] Direct on-chain LP estimate: ${lp_usd:,.2f}")
                except Exception as e:
                    print(f"[Scanner] On-chain LP check failed: {str(e)}")
            
            # Log this newly created pool as a raw launch
            self.log_new_launch(token_addr, name, symbol, lp_usd, pair_data)
            
            # Phase 1: Security Filters & Notifications
            if lp_usd >= 5000.0:  # Report any launch with at least $5000 liquidity
                renounced = self.scanner.check_ownership_renounced(token_addr)
                locked = self.scanner.check_liquidity_locked(pool_addr)
                
                # Check Auto-Buy Eligibility
                auto_buy_eligible = True
                skip_reason = ""
                
                if lp_usd < config.MIN_LIQUIDITY_USD:
                    auto_buy_eligible = False
                    skip_reason = f"Liquidity ${lp_usd:,.2f} is below auto-buy threshold of ${config.MIN_LIQUIDITY_USD:,.2f}"
                elif not renounced:
                    auto_buy_eligible = False
                    skip_reason = "Contract ownership is not renounced"
                elif not locked:
                    auto_buy_eligible = False
                    skip_reason = "Liquidity Pool is not locked"
                    
                # Log token deployment to Database
                self.db.log_token(token_addr, name, symbol, lp_usd)
                
                if auto_buy_eligible:
                    # Queue it for 10-minute maturity and honeypot validation check
                    self.pending_launches[token_addr.lower()] = {
                        'detected_at': time.time(),
                        'name': name,
                        'symbol': symbol,
                        'lp_usd': lp_usd,
                        'pool_addr': pool_addr,
                        'base_addr': base_addr,
                        'log': log
                    }
                    print(f"[Bot] Queued {symbol} for 10-minute maturity delay and sells audit.")
                else:
                    print(f"[Bot] Skipped launch for {symbol}. Reason: {skip_reason}")
        except Exception as e:
            print(f"[Scanner] Error processing log: {str(e)}")

    def calculate_slippage_limit(self, token_addr, amount_in, is_buy, pair_data=None):
        """Calculate amount_out_minimum with 10% slippage protection"""
        try:
            w3 = self.scanner.w3
            token_addr = w3.to_checksum_address(token_addr)
            
            # 1. Try to fetch live on-chain price first
            price_native = 0.0
            if pair_data and "pool_addr" in pair_data:
                try:
                    price_native = self.get_onchain_price(
                        token_addr=token_addr,
                        base_addr=pair_data.get("base_addr", config.WETH_ADDRESS),
                        pool_addr=pair_data["pool_addr"],
                        dex_version=pair_data.get("dex_version", "v3")
                    )
                except Exception as e:
                    print(f"[Slippage] Live on-chain price resolution failed: {str(e)}")
            
            # 2. Fallback to DexScreener stats
            if price_native <= 0:
                if not pair_data or "priceNative" not in pair_data:
                    pair_data_stats = self.tracker.fetch_dex_stats(token_addr)
                else:
                    pair_data_stats = pair_data
                if pair_data_stats:
                    price_native = float(pair_data_stats.get("priceNative", 0.0))
            
            if price_native <= 0:
                return 0
                
            token_contract = w3.eth.contract(
                address=token_addr,
                abi=self.scanner.erc20_abi
            )
            decimals = token_contract.functions.decimals().call()
            
            if is_buy:
                # WETH -> Token
                amount_in_eth = amount_in / 10**18
                expected_tokens_out = amount_in_eth / price_native
                amount_out_minimum = int(expected_tokens_out * (10 ** decimals) * 0.90)
                return amount_out_minimum
            else:
                # Token -> WETH
                token_amount_normalized = amount_in / (10 ** decimals)
                expected_weth_out = token_amount_normalized * price_native
                amount_out_minimum = int(expected_weth_out * (10 ** 18) * 0.90)
                return amount_out_minimum
        except Exception as e:
            print(f"[Slippage] Error calculating limit: {str(e)}")
            return 0

    def get_onchain_price(self, token_addr, base_addr, pool_addr, dex_version='v3'):
        """Fetch and convert slot0/getReserves price ratio from pool contract directly"""
        try:
            w3 = self.scanner.w3
            
            # Resolve decimals with ERC20 decimals check
            decimals_abi = [{"constant": True, "inputs": [], "name": "decimals", "outputs": [{"name": "", "type": "uint8"}], "payable": False, "stateMutability": "view", "type": "function"}]
            
            try:
                tc_decimals = w3.eth.contract(address=w3.to_checksum_address(token_addr), abi=decimals_abi)
                token_decimals = tc_decimals.functions.decimals().call()
            except:
                token_decimals = 18
                
            try:
                bc_decimals = w3.eth.contract(address=w3.to_checksum_address(base_addr), abi=decimals_abi)
                base_decimals = bc_decimals.functions.decimals().call()
            except:
                base_decimals = 18
                
            if dex_version == 'v2':
                # Uniswap V2 reserves
                pool_contract = w3.eth.contract(
                    address=w3.to_checksum_address(pool_addr),
                    abi=[
                        {"inputs": [], "name": "getReserves", "outputs": [{"name": "_reserve0", "type": "uint112"}, {"name": "_reserve1", "type": "uint112"}, {"name": "_blockTimestampLast", "type": "uint32"}], "stateMutability": "view", "type": "function"},
                        {"inputs": [], "name": "token0", "outputs": [{"name": "", "type": "address"}], "stateMutability": "view", "type": "function"},
                        {"inputs": [], "name": "token1", "outputs": [{"name": "", "type": "address"}], "stateMutability": "view", "type": "function"}
                    ]
                )
                reserves = pool_contract.functions.getReserves().call()
                reserve0, reserve1 = reserves[0], reserves[1]
                if reserve0 == 0 or reserve1 == 0:
                    return 0.0
                    
                token0 = pool_contract.functions.token0().call()
                
                if token_addr.lower() == token0.lower():
                    price_in_base = (reserve1 / reserve0) * (10**token_decimals) / (10**base_decimals)
                else:
                    price_in_base = (reserve0 / reserve1) * (10**token_decimals) / (10**base_decimals)
                return price_in_base
                
            else:
                # Uniswap V3 slot0
                pool_contract = w3.eth.contract(
                    address=w3.to_checksum_address(pool_addr),
                    abi=[
                        {"inputs": [], "name": "slot0", "outputs": [{"internalType": "uint160", "name": "sqrtPriceX96", "type": "uint160"}, {"internalType": "int24", "name": "tick", "type": "int24"}, {"internalType": "uint16", "name": "observationIndex", "type": "uint16"}, {"internalType": "uint16", "name": "observationCardinality", "type": "uint16"}, {"internalType": "uint16", "name": "observationCardinalityNext", "type": "uint16"}, {"internalType": "uint8", "name": "feeProtocol", "type": "uint8"}, {"internalType": "bool", "name": "unlocked", "type": "bool"}], "stateMutability": "view", "type": "function"},
                        {"inputs": [], "name": "token0", "outputs": [{"internalType": "address", "name": "", "type": "address"}], "stateMutability": "view", "type": "function"},
                        {"inputs": [], "name": "token1", "outputs": [{"internalType": "address", "name": "", "type": "address"}], "stateMutability": "view", "type": "function"}
                    ]
                )
                
                slot0 = pool_contract.functions.slot0().call()
                sqrtPriceX96 = slot0[0]
                if sqrtPriceX96 == 0:
                    return 0.0
                    
                token0 = pool_contract.functions.token0().call()
                ratio = (sqrtPriceX96 / (2**96)) ** 2
                
                if token_addr.lower() == token0.lower():
                    price_in_base = ratio * (10**token_decimals) / (10**base_decimals)
                else:
                    price_in_base = (1.0 / ratio) * (10**token_decimals) / (10**base_decimals)
                return price_in_base
                
        except Exception as e:
            print(f"[OnChainPrice] Error fetching price for {token_addr}: {str(e)}")
            return 0.0

    async def update_active_monitors(self):
        """Update metrics for active pools and evaluate exit alerts"""
        self.load_active_positions()
        
        # Fetch WETH price in USD once per tick to convert on-chain prices
        eth_pair = self.tracker.fetch_dex_stats("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2")
        eth_price = float(eth_pair.get("priceUsd", 1800.0)) if eth_pair else 1800.0
        
        for token_addr, data in list(self.active_monitors.items()):
            try:
                w3 = self.scanner.w3
                
                # Backward compatibility: initialize missing timestamp
                if 'timestamp' not in data:
                    data['timestamp'] = int(time.time())
                
                # Check current balance of the token in the wallet
                try:
                    token_contract = w3.eth.contract(
                        address=w3.to_checksum_address(token_addr),
                        abi=self.scanner.erc20_abi
                    )
                    token_bal = token_contract.functions.balanceOf(self.trader.address).call()
                    if token_bal <= 10**14:  # Dust/zero balance check
                        print(f"[Bot] Active position {data['symbol']} has 0/dust balance ({token_bal} units). Removing from registry.")
                        del self.active_monitors[token_addr]
                        self.save_active_positions()
                        continue
                except Exception as e:
                    print(f"[Bot] Could not query on-chain balance for {data['symbol']}: {str(e)}")
                    
                # 1. Resolve pool address if missing
                pool_addr = data.get('pool_addr')
                if not pool_addr:
                    factory_abi = [{
                        "inputs": [
                            {"name": "tokenA", "type": "address"},
                            {"name": "tokenB", "type": "address"},
                            {"name": "fee", "type": "uint24"}
                        ],
                        "name": "getPool",
                        "outputs": [{"name": "", "type": "address"}],
                        "type": "function"
                    }]
                    factory = w3.eth.contract(address=w3.to_checksum_address(config.UNISWAP_V3_FACTORY), abi=factory_abi)
                    resolved_pool = factory.functions.getPool(
                        w3.to_checksum_address(token_addr),
                        w3.to_checksum_address(data['base_addr']),
                        data['pool_fee']
                    ).call()
                    if resolved_pool and resolved_pool != "0x0000000000000000000000000000000000000000":
                        data['pool_addr'] = resolved_pool.lower()
                        self.save_active_positions()
                        pool_addr = resolved_pool.lower()
                
                # Fallback to DexScreener if pool_addr missing or on-chain call failed
                pair_data = self.tracker.fetch_dex_stats(token_addr)
                
                # Resolve dex version dynamically if missing
                if 'dex_version' not in data:
                    if pair_data:
                        labels = pair_data.get("labels", [])
                        data['dex_version'] = 'v2' if 'v2' in labels else 'v3'
                        self.save_active_positions()
                    else:
                        data['dex_version'] = 'v3'
                
                # 2. Fetch price (prefer real-time on-chain ratio)
                price = 0.0
                if pool_addr:
                    price_in_base = self.get_onchain_price(token_addr, data['base_addr'], pool_addr, dex_version=data.get('dex_version', 'v3'))
                    if price_in_base > 0.0:
                        price = price_in_base * eth_price
                
                if price <= 0.0:
                    if pair_data:
                        price = float(pair_data.get("priceUsd", 0))
                
                if price <= 0:
                    continue
                    
                # Dynamically initialize entry price if it was queued at 0.0 (delayed index)
                if data.get('entry_price', 0.0) <= 0.0:
                    data['entry_price'] = price
                    data['ath_price'] = price
                    data['prices'] = [price]
                    print(f"[Bot] DexScreener indexed! Locked initial entry price for {data['symbol']} at ${price:.8f}")
                    continue
                    
                volume_5m = float(pair_data.get("volume", {}).get("m5", 0)) if pair_data else 0.0
                
                # Append to rolling price and volume arrays
                if 'prices' not in data or not isinstance(data['prices'], list):
                    data['prices'] = []
                if 'volumes' not in data or not isinstance(data['volumes'], list):
                    data['volumes'] = []
                data['prices'].append(price)
                data['volumes'].append(volume_5m)
                if len(data['prices']) > 10:
                    data['prices'] = data['prices'][-10:]
                if len(data['volumes']) > 10:
                    data['volumes'] = data['volumes'][-10:]
                
                # Update multiplier and ATH (factor in round-trip gas fee)
                raw_mult = price / data['entry_price'] if data['entry_price'] > 0 else 1.0
                entry_size_eth = float(data.get('entry_size_eth', config.TRADE_AMOUNT_ETH))
                if entry_size_eth <= 0.0:
                    entry_size_eth = 0.005
                buy_gas_eth = float(data.get('buy_gas_eth', 0.0001))
                total_gas_eth = 2.0 * buy_gas_eth
                mult = max(0.01, raw_mult - (total_gas_eth / entry_size_eth))

                if mult > data['max_mult']:
                    data['max_mult'] = mult
                data['ath_price'] = max(data['ath_price'], price)
                
                # Initialize tp_level for backward compatibility (0 = initial, 1 = TP1 hit, 2 = TP2 hit / moonbag status)
                if 'tp_level' not in data:
                    data['tp_level'] = 2 if data.get('is_derisked', False) else 0

                # A1. Partial Profit Taking Level 1 (Take 40% Profit at 1.25x)
                if data['tp_level'] == 0 and mult >= config.TAKE_PROFIT_1_MULTIPLIER:
                    token_bal = self.trader.get_token_balance(token_addr)
                    sell_amt = int(token_bal * 0.40)
                    if sell_amt > 0:
                        print(f"[Trader] TP1: Selling 40% of {data['symbol']} ({sell_amt} units)...")
                        min_out = self.calculate_slippage_limit(token_addr, sell_amt, is_buy=False, pair_data=pair_data)
                        sell_success = self.trader.execute_swap(
                            token_in=token_addr,
                            token_out=data['base_addr'],
                            amount_in=sell_amt,
                            pool_fee=data['pool_fee'],
                            amount_out_minimum=min_out,
                            dex_version=data.get('dex_version', 'v3')
                        )
                        if sell_success:
                            data['tp_level'] = 1
                            self.log_closed_position(token_addr, price, "tp1_take_profit")
                            self.send_alert(
                                f"💰 *TAKE PROFIT (TP1): TOOK 40% PROFITS ON {data['symbol']}*\n"
                                f"-----------------------------------------\n"
                                f"• First target reached! Capital risk reduced by 40%.\n"
                                f"• Trigger Price: ${price:.8f} ({mult:.2f}x from entry)"
                            )

                # A2. Partial Profit Taking Level 2 (Take another 30% of initial position, i.e., 50% of remaining balance, at 1.60x)
                if data['tp_level'] == 1 and mult >= config.TAKE_PROFIT_2_MULTIPLIER:
                    token_bal = self.trader.get_token_balance(token_addr)
                    sell_amt = token_bal // 2
                    if sell_amt > 0:
                        print(f"[Trader] TP2: Selling 50% of remaining {data['symbol']} ({sell_amt} units)...")
                        min_out = self.calculate_slippage_limit(token_addr, sell_amt, is_buy=False, pair_data=pair_data)
                        sell_success = self.trader.execute_swap(
                            token_in=token_addr,
                            token_out=data['base_addr'],
                            amount_in=sell_amt,
                            pool_fee=data['pool_fee'],
                            amount_out_minimum=min_out,
                            dex_version=data.get('dex_version', 'v3')
                        )
                        if sell_success:
                            data['tp_level'] = 2
                            data['is_derisked'] = True  # Set true for legacy trailing compatibility
                            self.log_closed_position(token_addr, price, "tp2_take_profit")
                            self.send_alert(
                                f"💰 *TAKE PROFIT (TP2): TOOK 30% PROFITS ON {data['symbol']}*\n"
                                f"-----------------------------------------\n"
                                f"• Initial capital fully recovered with profit locked in!\n"
                                f"• Remaining 30% position is now riding as a zero-risk moonbag.\n"
                                f"• Trigger Price: ${price:.8f} ({mult:.2f}x from entry)"
                            )

                # B. Trailing Stop Loss on the Moonbag (e.g. 15% below ATH)
                if data.get('tp_level', 0) == 2 and price <= data['ath_price'] * config.TRAILING_STOP_THRESHOLD:
                    token_bal = self.trader.get_token_balance(token_addr)
                    print(f"[Trader] Trailing Stop: Exiting remaining moonbag of {data['symbol']}...")
                    min_out = self.calculate_slippage_limit(token_addr, token_bal, is_buy=False, pair_data=pair_data)
                    success = self.trader.execute_swap(
                        token_in=token_addr,
                        token_out=data['base_addr'],
                        amount_in=token_bal,
                        pool_fee=data['pool_fee'],
                        amount_out_minimum=min_out,
                        dex_version=data.get('dex_version', 'v3')
                    )
                    if success:
                        self.send_alert(
                            f"🚨 *TRAILING STOP TRIGGERED: EXITED {data['symbol']} MOONBAG*\n"
                            f"-----------------------------------------\n"
                            f"• Price dropped 15% from its peak ATH of ${data['ath_price']:.8f}.\n"
                            f"• Exited at: ${price:.8f}"
                        )
                        self.log_closed_position(token_addr, price, "trailing_stop_triggered")
                        self.db.update_metrics(token_addr, True, True, data['max_mult'], "trailing_stop_triggered")
                        del self.active_monitors[token_addr]
                        continue
                    else:
                        self.handle_exit_failure(token_addr, "Trailing Stop", price)
 
                # C. Stop Loss Check (Pre-derisk, trailing stop logic)
                if data.get('tp_level', 0) >= 1:
                    stop_loss_mult = 1.00
                    stop_loss_reason = "Break-Even Stop: Safeguarding remaining capital at entry cost basis after TP1 realized."
                else:
                    local_bottom = data.get('local_bottom', 0.0)
                    default_stop_mult = data.get('stop_loss_mult', config.STOP_LOSS_MULTIPLIER)
                    
                    # Scale support floor buffer based on stop loss multiplier (widen buffer for thin pools)
                    support_buffer = 0.95
                    if default_stop_mult <= 0.81: # Thin pool (20% SL) -> 12% off support
                        support_buffer = 0.88
                    elif default_stop_mult <= 0.86: # Medium pool (15% SL) -> 8% off support
                        support_buffer = 0.92
                    else: # Thick pool (10% SL) -> 4% off support
                        support_buffer = 0.96
                        
                    if local_bottom > 0.0:
                        support_stop_mult = (local_bottom * support_buffer) / data['entry_price']
                        if support_stop_mult < default_stop_mult:
                            stop_loss_mult = default_stop_mult
                            stop_loss_reason = f"Cut losses. Capped max drawdown at {(1 - default_stop_mult)*100:.0f}% of entry (support floor was too deep at -{(1 - support_stop_mult)*100:.1f}%)."
                        else:
                            stop_loss_mult = support_stop_mult
                            stop_loss_price = local_bottom * support_buffer
                            stop_loss_reason = f"Cut losses. Price broke below support floor invalidation level of ${stop_loss_price:.8f} (-{(1 - support_buffer)*100:.0f}% off support bottom)."
                    else:
                        stop_loss_mult = default_stop_mult
                        stop_loss_reason = f"Cut losses. Price dropped below {default_stop_mult * 100:.0f}% of entry."
                
                # Dynamic pre-de-risk profit trailing locks and break-even stops
                if not data['is_derisked']:
                    if data['max_mult'] >= 1.25:
                        stop_loss_mult = 1.15  # Lock in +15% profit
                        stop_loss_reason = "Trailing Stop: Locked in +15% profit as token dropped from its +25% peak."
                    elif data['max_mult'] >= 1.20:
                        stop_loss_mult = 1.10  # Lock in +10% profit
                        stop_loss_reason = "Trailing Stop: Locked in +10% profit as token dropped from its +20% peak."
                    elif data['max_mult'] >= 1.15:
                        stop_loss_mult = 1.05  # Lock in +5% profit
                        stop_loss_reason = "Trailing Stop: Locked in +5% profit as token dropped from its +15% peak."
 
                if not data['is_derisked'] and raw_mult <= stop_loss_mult:
                    token_bal = self.trader.get_token_balance(token_addr)
                    print(f"[Trader] Stop Loss Triggered: Exiting entire position for {data['symbol']} (Trigger Mult: {stop_loss_mult:.2f})...")
                    min_out = self.calculate_slippage_limit(token_addr, token_bal, is_buy=False, pair_data=pair_data)
                    success = self.trader.execute_swap(
                        token_in=token_addr,
                        token_out=data['base_addr'],
                        amount_in=token_bal,
                        pool_fee=data['pool_fee'],
                        amount_out_minimum=min_out,
                        dex_version=data.get('dex_version', 'v3')
                    )
                    if success:
                        p_l_pct = (mult - 1) * 100
                        p_l_sign = "+" if p_l_pct >= 0 else ""
                        self.send_alert(
                            f"🚨 *STOP LOSS TRIGGERED: EXITED {data['symbol']}*\n"
                            f"-----------------------------------------\n"
                            f"• {stop_loss_reason}\n"
                            f"• Exit Price: ${price:.8f} (Net P/L: {p_l_sign}{p_l_pct:.2f}%)"
                        )
                        self.log_closed_position(token_addr, price, "stop_loss_triggered")
                        self.db.update_metrics(token_addr, True, False, data['max_mult'], "stop_loss_triggered")
                        del self.active_monitors[token_addr]
                        continue
                    else:
                        self.handle_exit_failure(token_addr, "Stop Loss", price)
 
                # Time Stop Exit check
                elapsed = time.time() - data.get('timestamp', time.time())
                time_limit = getattr(config, 'TIME_STOP_SECONDS', 900)
                if elapsed > time_limit:
                    # Check 1h momentum to decide if we extend holding window
                    if pair_data:
                        buys_1h = int(pair_data.get("txns", {}).get("h1", {}).get("buys", 0))
                        sells_1h = int(pair_data.get("txns", {}).get("h1", {}).get("sells", 0))
                        if buys_1h > 1.2 * sells_1h and buys_1h >= 5:
                            print(f"[Time Stop] Strong buy momentum active for {data['symbol']} (1h Buys: {buys_1h} > 1.2x Sells: {sells_1h}). Extending position hold window by 30 minutes.")
                            data['timestamp'] = data.get('timestamp', time.time()) + 1800
                            self.save_active_positions()
                            continue
                    token_bal = self.trader.get_token_balance(token_addr)
                    print(f"[Trader] Time Stop Triggered: Exiting entire position for {data['symbol']} (Held {elapsed/60:.1f}m)...")
                    min_out = self.calculate_slippage_limit(token_addr, token_bal, is_buy=False, pair_data=pair_data)
                    success = self.trader.execute_swap(
                        token_in=token_addr,
                        token_out=data['base_addr'],
                        amount_in=token_bal,
                        pool_fee=data['pool_fee'],
                        amount_out_minimum=min_out,
                        dex_version=data.get('dex_version', 'v3')
                    )
                    if success:
                        p_l_pct = (mult - 1) * 100
                        p_l_sign = "+" if p_l_pct >= 0 else ""
                        self.send_alert(
                            f"⏱️ *TIME STOP TRIGGERED: EXITED {data['symbol']}*\n"
                            f"-----------------------------------------\n"
                            f"• Auto-exited position after holding for {elapsed/60:.1f} minutes to keep capital liquid.\n"
                            f"• Exit Price: ${price:.8f} (Net P/L: {p_l_sign}{p_l_pct:.2f}%)"
                        )
                        self.log_closed_position(token_addr, price, "time_stop_triggered")
                        self.db.update_metrics(token_addr, True, False, data['max_mult'], "time_stop_triggered")
                        del self.active_monitors[token_addr]
                        continue
                    else:
                        self.handle_exit_failure(token_addr, "Time Stop", price)

                # 1. Check Momentum
                if pair_data:
                    roc = self.tracker.calculate_volume_roc(data['volumes'])
                    trades_5m = int(pair_data.get("txns", {}).get("m5", {}).get("buys", 0)) + int(pair_data.get("txns", {}).get("m5", {}).get("sells", 0))
                    velocity_hr = trades_5m * 12 # estimate hourly velocity
                    
                    if velocity_hr >= config.VELOCITY_THRESHOLD and len(data['prices']) == 3:
                        self.send_alert(self.format_momentum_alert(token_addr, data['symbol'], price, roc, velocity_hr))
                        
                    # 2. Check Exits (Exhaustion Signals)
                    exit_signals = self.tracker.evaluate_exit_signals(pair_data, data['prices'], data['volumes'])
                    if exit_signals and mult >= 0.98:
                        token_bal = self.trader.get_token_balance(token_addr)
                        print(f"[Trader] Momentum Exhaustion: Exiting remaining position for {data['symbol']}...")
                        success = self.trader.execute_swap(
                            token_in=token_addr,
                            token_out=data['base_addr'],
                            amount_in=token_bal,
                            pool_fee=data['pool_fee'],
                            dex_version=data.get('dex_version', 'v3')
                        )
                        if success:
                            self.send_alert(self.format_exit_alert(data['symbol'], exit_signals, (mult - 1) * 100))
                            self.log_closed_position(token_addr, price, "momentum_exhaustion")
                            self.db.update_metrics(token_addr, True, True, data['max_mult'], "exit_signaled")
                            del self.active_monitors[token_addr]
                        else:
                            self.handle_exit_failure(token_addr, "Momentum Exhaustion", price)
                    
            except Exception as e:
                print(f"[Tracker] Error updating monitor for {token_addr}: {str(e)}")
        # Save positions at the end of every update cycle to persist metrics and exits
        self.save_active_positions()

    async def check_watchlist_reclaims(self):
        """Monitor watchlist tokens and execute auto-buyback swaps on bullish reclaim triggers"""
        # Check Daily Drawdown Lockout
        if self.check_daily_drawdown_lockout():
            print("[Watchlist] Peak-to-Trough Daily Drawdown Lockout is Active. Suspending new buybacks.")
            return

        cb_triggered, cb_loss = self.check_circuit_breaker()
        if cb_triggered:
            print(f"[Watchlist] Circuit Breaker Active (Daily Loss: {cb_loss:.1f}% >= {config.CIRCUIT_BREAKER_DAILY_LOSS_PCT}%). Suspending buybacks.")
            return

        # Check Daily Profit Goal
        goal_hit, today_gain = self.check_daily_profit_goal()
        if goal_hit:
            if not getattr(self, "profit_goal_alert_sent", False):
                self.send_alert(
                    f"🏆 *DAILY PROFIT GOAL REACHED!*\n"
                    f"-----------------------------------------\n"
                    f"• Today's Net Gain: +{today_gain:.1f}%\n"
                    f"• Target Goal: {config.DAILY_PROFIT_GOAL_PCT}%\n"
                    f"• Action: Halting new buybacks for the rest of the day to lock in today's wins! 🔒"
                )
                self.profit_goal_alert_sent = True
            print(f"[Watchlist] Daily Profit Goal Hit ({today_gain:.1f}% >= {config.DAILY_PROFIT_GOAL_PCT}%). Suspending buybacks to lock in today's wins.")
            return
        else:
            self.profit_goal_alert_sent = False

        # Check Max Concurrent Positions Limit
        max_positions = getattr(config, "MAX_CONCURRENT_POSITIONS", 2)
        if len(self.active_monitors) >= max_positions:
            print(f"[Watchlist] At maximum concurrent positions ({len(self.active_monitors)} >= {max_positions}). Suspending new purchases.")
            return
            
        self.load_watchlist()
        if not self.watchlist:
            return

        query_addrs = []
        for token_addr in self.watchlist.keys():
            if token_addr.lower() not in self.active_monitors:
                query_addrs.append(token_addr.lower())

        if not query_addrs:
            return

        batch_pair_data = {}
        chunk_size = 30
        for i in range(0, len(query_addrs), chunk_size):
            chunk = query_addrs[i:i+chunk_size]
            chunk_results = self.tracker.fetch_batch_dex_stats(chunk)
            batch_pair_data.update(chunk_results)

        for token_addr, data in list(self.watchlist.items()):
            token_addr_lower = token_addr.lower()
            if token_addr_lower in self.active_monitors:
                continue

            pair_data = batch_pair_data.get(token_addr_lower)
            if not pair_data:
                continue

            try:
                price = float(pair_data.get("priceUsd", 0))
                if price <= 0:
                    continue

                # 1. Evaluate Reclaim Condition
                target_reclaim = float(data.get("target_reclaim_price", 0.0))
                local_bottom = float(data.get("last_bottom_price", 0.0))

                # Update trailing local support bottom if price goes lower
                if local_bottom <= 0.0 or price < local_bottom:
                    data["last_bottom_price"] = price
                    self.save_watchlist()
                    continue

                should_buy = False
                trigger_reason = ""
                
                # Check Hard Reclaim Target
                if target_reclaim > 0.0 and price >= target_reclaim:
                    should_buy = True
                    trigger_reason = f"Price broke above breakout target of ${target_reclaim:.8f} (Current: ${price:.8f})"
                # Check Dynamic Reclaim Target (30% rise off bottom + minimum volume + positive hourly trend safety)
                elif target_reclaim <= 0.0 and price >= local_bottom * 1.30:
                    volume_5m = float(pair_data.get("volume", {}).get("m5", 0))
                    price_change_h1 = float(pair_data.get("priceChange", {}).get("h1", 0.0) or 0.0)
                    if volume_5m >= 2500.0 and price_change_h1 >= 0.0:
                        should_buy = True
                        trigger_reason = f"Price rose 30% off local support of ${local_bottom:.8f} with active volume (${volume_5m:,.0f}) and positive h1 trend ({price_change_h1}% / Current: ${price:.8f})"

                if should_buy:
                    # Check watchlist buyback liquidity floor
                    lp_usd = float(pair_data.get("liquidity", {}).get("usd", 0) or 0)
                    if lp_usd < config.MIN_BUYBACK_LIQUIDITY_USD:
                        print(f"[Watchlist] Skipped buyback for {data['symbol']}: Liquidity ${lp_usd:,.2f} is below floor of ${config.MIN_BUYBACK_LIQUIDITY_USD:,.2f}.")
                        continue
                        
                    print(f"[Watchlist] Reclaim condition met for {data['symbol']}! Reason: {trigger_reason}")
                    
                    # 2. Resolve dex version, pool fee, and pool address dynamically
                    w3 = self.scanner.w3
                    labels = pair_data.get("labels", []) if pair_data else []
                    dex_version = 'v2' if 'v2' in labels else 'v3'
                    
                    pool_fee = 10000
                    p = None
                    
                    if dex_version == 'v2':
                        p = pair_data.get("pairAddress", "")
                    else:
                        factory_abi = [{
                            "inputs": [
                                {"name": "tokenA", "type": "address"},
                                {"name": "tokenB", "type": "address"},
                                {"name": "fee", "type": "uint24"}
                            ],
                            "name": "getPool",
                            "outputs": [{"name": "", "type": "address"}],
                            "type": "function"
                        }]
                        factory = w3.eth.contract(
                            address=w3.to_checksum_address(config.UNISWAP_V3_FACTORY),
                            abi=factory_abi
                        )
                        best_pool = None
                        best_liquidity = -1
                        best_fee = 3000
                        
                        for fee in [10000, 3000, 500]:
                            try:
                                p_v3 = factory.functions.getPool(
                                    w3.to_checksum_address(token_addr_lower),
                                    w3.to_checksum_address(config.WETH_ADDRESS),
                                    fee
                                ).call()
                                if p_v3 and p_v3 != "0x0000000000000000000000000000000000000000":
                                    pool_contract = w3.eth.contract(
                                        address=w3.to_checksum_address(p_v3),
                                        abi=[{"inputs": [], "name": "liquidity", "outputs": [{"internalType": "uint128", "name": "", "type": "uint128"}], "stateMutability": "view", "type": "function"}]
                                    )
                                    liq = pool_contract.functions.liquidity().call()
                                    if liq > best_liquidity:
                                        best_liquidity = liq
                                        best_pool = p_v3
                                        best_fee = fee
                            except Exception as e:
                                print(f"[Pool Resolution] Error checking pool for fee {fee}: {str(e)}")
                                continue
                                
                        if best_pool:
                            pool_fee = best_fee
                            p = best_pool

                    # 3. Execute buyback swap on-chain
                    weth_contract = w3.eth.contract(
                        address=w3.to_checksum_address(config.WETH_ADDRESS),
                        abi=self.scanner.erc20_abi
                    )
                    weth_bal = float(w3.from_wei(weth_contract.functions.balanceOf(self.trader.address).call(), 'ether'))
                    min_bal = getattr(config, "MIN_TRADING_BALANCE_ETH", 0.005)
                    if weth_bal < min_bal:
                        print(f"[Watchlist] WETH balance ({weth_bal:.6f} ETH) is below the capital protection floor of {min_bal:.6f} ETH. Skipping buyback for {data['symbol']}.")
                        continue
                    
                    # Calculate Conviction Score dynamically (0 - 100)
                    score = self.calculate_conviction_score(pair_data)
                    
                    # Resolve sizing multiplier based on score
                    if score < 40:
                        print(f"[Watchlist] Skipped buyback for {data['symbol']}: Conviction score too low ({score}/100).")
                        continue
                    
                    # 1. Base trade size is percentage-of-balance or config default
                    # Determine standard size (e.g. 10% of balance, capped by max config value)
                    standard_size_eth = weth_bal * (getattr(config, "BASE_TRADE_SIZE_PCT", 10.0) / 100.0)
                    standard_size_eth = min(standard_size_eth, getattr(config, "MAX_TRADE_AMOUNT_ETH", 0.005))
                    
                    # 2. Scale size based on score tier
                    if score >= 80:
                        # High Conviction: 1.5x trade size
                        sizing_eth = standard_size_eth * 1.5
                        score_label = "HIGH"
                    elif score >= 60:
                        # Medium Conviction: 1.0x trade size
                        sizing_eth = standard_size_eth * 1.0
                        score_label = "MEDIUM"
                    else:
                        # Low Conviction: 0.5x trade size
                        sizing_eth = standard_size_eth * 0.5
                        score_label = "LOW"
                        
                    # 3. Balance protections
                    # If total balance is very low (e.g. < $15.00), skip low-conviction trades to protect from gas eating it up
                    portfolio_usd = self.get_total_portfolio_usd()
                    if portfolio_usd < 15.0 and score < 60:
                        print(f"[Watchlist] Skipped low-conviction buyback for {data['symbol']}: Portfolio balance is low (${portfolio_usd:.2f}) and gas fee dilution protection is active.")
                        continue
                        
                    # 4. Resolve Dynamic Stop-Loss and Risk-Adjusted Sizing based on pool liquidity
                    stop_loss_mult = 0.85 # Default to -15% stop loss (Medium pool)
                    risk_size_multiplier = 1.0
                    
                    if lp_usd < 15000.0:
                        # 🚨 Thin Pool: Give it 20% room to breathe to survive noise wiggles
                        stop_loss_mult = 0.80
                        risk_size_multiplier = 0.6  # Scale size down to balance dollar risk
                    elif lp_usd < 35000.0:
                        # ⚠️ Medium Pool: Give it 15% room to breathe
                        stop_loss_mult = 0.85
                        risk_size_multiplier = 0.8
                    else:
                        # 🟢 Thick Pool: Keep a tight -10% cut
                        stop_loss_mult = 0.90
                        risk_size_multiplier = 1.2
                        
                    sizing_eth = sizing_eth * risk_size_multiplier
                    
                    # Enforce minimum size floor of 0.0015 ETH to prevent gas fee dilution
                    # unless total balance is extremely small and we are forced to scale down
                    min_floor = 0.0015
                    if sizing_eth < min_floor and weth_bal >= min_floor:
                        sizing_eth = min_floor
                        
                    # Final safety check against balance limit
                    if sizing_eth > weth_bal * 0.95:
                        sizing_eth = weth_bal * 0.95
                        
                    if sizing_eth < 0.0005:
                        print(f"[Watchlist] Sizing {sizing_eth:.6f} ETH is below absolute minimum of 0.0005. Skipping.")
                        continue
                        
                    # Audit token buy tax before executing swap
                    if p:
                        if not self.verify_token_tax_safety(token_addr_lower, p, data['symbol'], dex_version=dex_version):
                            continue

                    amount_in_wei = int(sizing_eth * 10**18)
                    buy_success = False
 
                    if config.TRADE_EXECUTION_ENABLED:
                        print(f"[Trader] Executing automated buyback swap for {data['symbol']} (Fixed Sizing: {sizing_eth:.6f} ETH)...")
 
                        min_out = self.calculate_slippage_limit(token_addr_lower, amount_in_wei, is_buy=True, pair_data=pair_data)
                        buy_success = self.trader.execute_swap(
                            token_in=config.WETH_ADDRESS,
                            token_out=token_addr_lower,
                            amount_in=amount_in_wei,
                            pool_fee=pool_fee,
                            amount_out_minimum=min_out,
                            dex_version=dex_version
                        )
                    else:
                        buy_success = True
 
                    if buy_success:
                        # 4. Query live on-chain price immediately to lock in the exact filled price
                        try:
                            eth_pair = self.tracker.fetch_dex_stats("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2")
                            eth_price = float(eth_pair.get("priceUsd", 1800.0)) if eth_pair else 1800.0
                            p_addr = p if p else None
                            if p_addr:
                                onchain_price = self.get_onchain_price(token_addr_lower, config.WETH_ADDRESS, p_addr, dex_version=dex_version)
                                if onchain_price > 0.0:
                                    price = onchain_price * eth_price
                                    print(f"[Trader] Overrode entry price to on-chain fill: ${price:.8f}")
                        except Exception as e:
                            print(f"[Trader] Error resolving immediate entry price on-chain: {str(e)}")

                        # Register position in active positions for automatic monitoring and stop-loss logic
                        self.active_monitors[token_addr_lower] = {
                            'prices': [price],
                            'volumes': [float(pair_data.get("volume", {}).get("m5", 0))],
                            'symbol': data['symbol'],
                            'max_mult': 1.0,
                            'entry_price': price,
                            'ath_price': price,
                            'is_derisked': False,
                            'base_addr': config.WETH_ADDRESS,
                            'pool_fee': pool_fee,
                            'pool_addr': p.lower() if p else None,
                            'dex_version': dex_version,
                            'buy_success': True,
                            'conviction_tier': 2,
                            'de_risk_target': 1.3,
                            'local_bottom': local_bottom,
                            'entry_size_eth': sizing_eth,
                            'stop_loss_mult': stop_loss_mult,
                            'timestamp': int(time.time())
                        }
                        self.save_active_positions()
                        self.watchlist[token_addr]['last_bottom_price'] = price
                        if 'target_reclaim_price' in self.watchlist[token_addr]:
                            self.watchlist[token_addr]['target_reclaim_price'] = 0.0
                        self.save_watchlist()

                        # Dispatch Telegram notification
                        self.send_alert(
                            f"🚀 *WATCHLIST BUYBACK TRIGGERED: {data['symbol']}*\n"
                            f"-----------------------------------------\n"
                            f"• {trigger_reason}\n"
                            f"• Entry Sizing: {sizing_eth} ETH"
                        )
            except Exception as e:
                print(f"[Watchlist] Error evaluating reclaim for {token_addr_lower}: {str(e)}")

    async def check_high_cap_momentum(self):
        """Monitor top trading high-cap pairs on Robinhood L2 and alert on momentum breakouts"""
        now = time.time()
        self.last_momentum_alert = getattr(self, 'last_momentum_alert', {})
        self.trending_history = getattr(self, 'trending_history', {})
        
        try:
            import requests
            # Query trending pairs from DexScreener search API for Robinhood Chain
            url = "https://api.dexscreener.com/latest/dex/search?q=0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"
            r = requests.get(url, headers={
                "User-Agent": "Mozilla/5.0",
                "Accept": "application/json"
            }, timeout=10).json()
            pairs = r.get("pairs", [])
            
            robinhood_pairs = [p for p in pairs if p.get("chainId") == "robinhood"]
            
            for p in robinhood_pairs:
                token_addr = p.get("baseToken", {}).get("address", "").lower()
                symbol = p.get("baseToken", {}).get("symbol", "")
                name = p.get("baseToken", {}).get("name", "")
                
                if not token_addr:
                    continue

                # Check if high-cap (Liquidity >= $25k)
                lp_usd = float(p.get("liquidity", {}).get("usd", 0) or 0)
                if lp_usd < 25000.0:
                    continue
                    
                # Skip if we already own it
                if token_addr in self.active_monitors:
                    continue
                    
                # Skip if on cooldown (1 hour = 3600 seconds)
                if token_addr in self.last_momentum_alert:
                    if now - self.last_momentum_alert[token_addr] < 3600:
                        continue
                        
                price = float(p.get("priceUsd", 0) or 0)
                volume_5m = float(p.get("volume", {}).get("m5", 0) or 0)
                price_change_5m = float(p.get("priceChange", {}).get("m5", 0) or p.get("priceChange", {}).get("h1", 0) or 0.0)
                
                # Record rolling metrics history
                if token_addr not in self.trending_history:
                    self.trending_history[token_addr] = {
                        "prices": [],
                        "volumes": []
                    }
                    
                history = self.trending_history[token_addr]
                history["prices"].append(price)
                history["volumes"].append(volume_5m)
                
                if len(history["prices"]) > 5:
                    history["prices"].pop(0)
                    history["volumes"].pop(0)
                    
                if len(history["prices"]) >= 3:
                    prev_vol = history["volumes"][-2]
                    curr_vol = history["volumes"][-1]
                    
                    vol_spike = False
                    vol_roc = 0.0
                    if prev_vol > 500.0:
                        vol_roc = ((curr_vol - prev_vol) / prev_vol) * 100.0
                        if vol_roc >= 120.0 and curr_vol >= 3000.0:
                            vol_spike = True
                            
                    # Price breakout: rising price (>3%)
                    price_rising = (price_change_5m > 3.0)
                    
                    if vol_spike and price_rising:
                        self.last_momentum_alert[token_addr] = now
                        self.pending_momentum_alerts[token_addr] = {
                            'symbol': symbol,
                            'name': name,
                            'lp_usd': lp_usd,
                            'vol_roc': vol_roc,
                            'price_change_5m': price_change_5m,
                            'price': price
                        }
                        print(f"[Watchlist] Queued High-Cap Momentum Alert for {symbol} at ${price:.8f}")
                        
                        # Auto-add to watchlist if LP is high-cap (>= $50k)
                        if lp_usd >= 50000.0 and token_addr not in self.watchlist:
                            self.watchlist[token_addr] = {
                                'symbol': symbol,
                                'name': name,
                                'target_reclaim_price': 0.0,
                                'last_bottom_price': price
                            }
                            self.save_watchlist()
                            self.send_alert(
                                f"🤖 *AUTOMATIC WATCHLIST ADDITION: {symbol}*\n"
                                f"-----------------------------------------\n"
                                f"• High-Cap Momentum Breakout detected!\n"
                                f"• Liquidity Pool: ${lp_usd:,.2f} LP\n"
                                f"• 5m Volume spike: +{vol_roc:.1f}%\n"
                                f"• 5m Price change: +{price_change_5m:.1f}%\n"
                                f"-----------------------------------------\n"
                                f"📈 Now tracking support reclaims dynamically."
                            )
                        
        except Exception as e:
            print(f"[Watchlist] Error in high-cap momentum scanner: {str(e)}")

    async def dispatch_momentum_summary(self):
        """Dispatch a single batched summary alert containing all pending high-cap momentum plays"""
        if not self.pending_momentum_alerts:
            return
            
        alerts_list = []
        count = 1
        for token_addr, data in list(self.pending_momentum_alerts.items()):
            alerts_list.append(
                f"{count}. *{data['symbol']}* ({data['name']}) - `{token_addr}`\n"
                f"   ▪️ *Liquidity:* ${data['lp_usd']:,.2f}\n"
                f"   ▪️ *Volume ROC (5m):* +{data['vol_roc']:.1f}%\n"
                f"   ▪️ *Price Change (5m):* +{data['price_change_5m']:.1f}%\n"
                f"   ▪️ *Current Price:* ${data['price']:.8f}\n"
                f"   📊 [DexScreener Link](https://dexscreener.com/robinhood/{token_addr})"
            )
            count += 1
            
        summary_msg = (
            f"🔥 *HIGH-CAP MOMENTUM BREAKOUTS (5-MIN SUMMARY)*\n"
            f"-----------------------------------------\n\n"
            + "\n\n".join(alerts_list) + "\n\n"
            f"-----------------------------------------\n"
            f"💡 *Action:* These established tokens are gaining active momentum. Monitor for manual entries or add to watchlist to buy the pullbacks automatically."
        )
        
        self.send_alert(summary_msg)
        self.pending_momentum_alerts.clear()
        print(f"[Watchlist] Dispatched 5-min momentum summary alert to Telegram/Discord.")

    async def check_pending_launches(self):
        """Audit queued launches after a 10-minute maturity period to verify sells and protect against honeypots"""
        cb_triggered, cb_loss = self.check_circuit_breaker()
        if cb_triggered:
            print(f"[Bot] Circuit Breaker Active (Daily Loss: {cb_loss:.1f}% >= {config.CIRCUIT_BREAKER_DAILY_LOSS_PCT}%). Suspending new purchases.")
            return
            
        now = time.time()
        for token_addr, data in list(self.pending_launches.items()):
            try:
                age_sec = now - data['detected_at']
                
                # Check 10 minutes maturity (600 seconds)
                if age_sec < 600:
                    continue
                    
                # Fetch DexScreener stats
                pair_data = self.tracker.fetch_dex_stats(token_addr)
                
                # If the pair has been deleted or cannot be resolved, check if it's over 30 mins old
                if not pair_data:
                    if age_sec >= 1800:
                        print(f"[Bot] Purging unresolved/dead queued token {data['symbol']} from pending launches.")
                        del self.pending_launches[token_addr]
                    continue
                    
                # Honeypot check: check the number of sell transactions in the last hour
                sells_h1 = int(pair_data.get("txns", {}).get("h1", {}).get("sells", 0) or 0)
                
                # Sells count check (Must be >= 15 sells, proving people can exit and contract is not a honeypot)
                if sells_h1 < 15:
                    print(f"[Bot] Skipped buying {data['symbol']}: only {sells_h1} sells in the last hour (potential honeypot or dead volume).")
                    del self.pending_launches[token_addr]
                    continue
                    
                # Buy-to-Sell ratio check to prevent honeypots/wash-trades
                buys_h1 = int(pair_data.get("txns", {}).get("h1", {}).get("buys", 0) or 0)
                if sells_h1 > 0:
                    bs_ratio = buys_h1 / sells_h1
                    if bs_ratio > config.MAX_BUY_SELL_RATIO:
                        print(f"[Bot] Skipped buying {data['symbol']}: Buy/Sell ratio of {bs_ratio:.2f} is too high (potential honeypot or wash-traded scam).")
                        del self.pending_launches[token_addr]
                        continue
                    
                # Re-verify safety indicators (Renounced and Locked)
                renounced = self.scanner.check_ownership_renounced(token_addr)
                locked = self.scanner.check_liquidity_locked(data['pool_addr'])
                
                if not renounced or not locked:
                    print(f"[Bot] Skipped buying {data['symbol']}: safety re-check failed. Renounced: {renounced}, Locked: {locked}.")
                    del self.pending_launches[token_addr]
                    continue
                    
                # Passed all filters! Add to Watchlist for safe reclaim plays instead of buying
                lp_usd = float(pair_data.get("liquidity", {}).get("usd", data['lp_usd']) or data['lp_usd'])
                price = float(pair_data.get("priceUsd", 0))

                if token_addr not in self.watchlist:
                    self.watchlist[token_addr] = {
                        'symbol': data['symbol'],
                        'name': data['name'],
                        'target_reclaim_price': 0.0,
                        'last_bottom_price': price if price > 0 else 0.0
                    }
                    self.save_watchlist()

                    alert_msg = (
                        f"🤖 *AUTOMATIC WATCHLIST ADDITION: {data['symbol']}*\n"
                        f"-----------------------------------------\n"
                        f"• Verified runner passed all safety filters!\n"
                        f"• Liquidity Pool: ${lp_usd:,.2f} LP\n"
                        f"• Honeypot Audit: ✅ PASSED ({sells_h1} sells verified)\n"
                        f"-----------------------------------------\n"
                        f"📈 Now tracking support reclaims dynamically."
                    )
                    self.send_alert(alert_msg)
                
                # Always remove from queue once processed
                del self.pending_launches[token_addr]
                
            except Exception as e:
                print(f"[Bot] Error evaluating pending launch check for {token_addr}: {str(e)}")

    async def _run_simulation(self):
        """Runs the simulation steps as a local fallback"""
        mock_addr = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"
        mock_name = "Robinhood Gold Coin"
        mock_symbol = "GOLD"
        
        await asyncio.sleep(2)
        print("\n--- Phase 1: Launch Trigger ---")
        launch_msg = self.format_launch_alert(mock_addr, mock_name, mock_symbol, 15000.0, True, True, 2, 0.005, 2.0)
        self.send_alert(launch_msg)
        self.db.log_token(mock_addr, mock_name, mock_symbol, 15000.0)
        self.active_monitors[mock_addr.lower()] = {
            'prices': [0.0001, 0.00012, 0.00015],
            'volumes': [5000, 7500, 15000],
            'symbol': mock_symbol,
            'max_mult': 1.5,
            'entry_price': 0.0001,
            'ath_price': 0.00015,
            'is_derisked': False,
            'base_addr': "0x82af49447d8a07e3bd95bd0d56f352415231aa11",
            'pool_fee': 3000,
            'buy_success': True
        }

        await asyncio.sleep(4)
        print("\n--- Phase 2: Momentum Build Trigger ---")
        token_data = self.active_monitors[mock_addr.lower()]
        roc = self.tracker.calculate_volume_roc(token_data['volumes'])
        momentum_msg = self.format_momentum_alert(mock_addr, mock_symbol, 0.00015, roc, 310)
        self.send_alert(momentum_msg)

        await asyncio.sleep(4)
        print("\n--- Phase 3: Exhaustion & Exit Trigger ---")
        token_data['prices'].append(0.00022)
        token_data['volumes'].append(8000)
        
        fake_pair_data = {"liquidity": {"usd": 12000}, "volume": {"h24": 120000}, "priceChange": {"m5": -18.0}}
        signals = self.tracker.evaluate_exit_signals(fake_pair_data, token_data['prices'], token_data['volumes'])
        if signals:
            exit_msg = self.format_exit_alert(mock_symbol, signals, 120.0)
            self.send_alert(exit_msg)
            self.db.update_metrics(mock_addr, True, True, 2.2, "exit_signaled")

        # Simulate the new 10-Minute Heartbeat and Summary Alerts
        print("\n--- Simulation: Heartbeat & Summary Report ---")
        # 1. Test empty heartbeat message
        self.active_monitors.clear()
        await self.send_periodic_summary()
        
        # 2. Test active runner summary message
        self.active_monitors[mock_addr.lower()] = {
            'prices': [0.0001],
            'volumes': [5000],
            'symbol': mock_symbol,
            'max_mult': 2.2,
            'entry_price': 0.0001,
            'ath_price': 0.00022,
            'is_derisked': True,
            'base_addr': "0x82af49447d8a07e3bd95bd0d56f352415231aa11",
            'pool_fee': 3000,
            'buy_success': True
        }
        await self.send_periodic_summary()
    def log_new_launch(self, token_addr, name, symbol, lp_usd, pair_data):
        """Append newly discovered token to the rolling new_launches.json registry"""
        try:
            import os
            import json
            import time
            
            launch_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "new_launches.json")
            
            # Load existing launches
            launches = []
            if os.path.exists(launch_file):
                try:
                    with open(launch_file, "r") as f:
                        launches = json.load(f)
                except:
                    launches = []
            
            # Check if this token is already registered to avoid duplication
            if any(item["address"].lower() == token_addr.lower() for item in launches):
                return
                
            # Extract image/logo URL if available
            image_url = ""
            if pair_data and pair_data.get("info"):
                image_url = pair_data.get("info", {}).get("imageUrl", "")
                
            new_item = {
                "address": token_addr,
                "name": name,
                "symbol": symbol,
                "lp_usd": lp_usd,
                "image_url": image_url,
                "timestamp": time.time()
            }
            
            launches.insert(0, new_item) # Add to the beginning (newest first)
            launches = launches[:30]     # Keep the last 30 launches only
            
            with open(launch_file, "w") as f:
                json.dump(launches, f, indent=2)
        except Exception as e:
            print(f"[Bot] Error logging new launch to JSON: {str(e)}")

    def handle_exit_failure(self, token_addr, reason, price):
        """Handle a failed exit swap attempt, tracking failures to prevent gas-drain loops"""
        token_addr_lower = token_addr.lower()
        data = self.active_monitors.get(token_addr_lower)
        if not data:
            return
            
        failed_attempts = data.get('failed_attempts', 0) + 1
        data['failed_attempts'] = failed_attempts
        print(f"[Trader] Exit transaction failed for {data['symbol']} ({reason}). Failure count: {failed_attempts}/3")
        
        if failed_attempts >= 3:
            print(f"[Trader] Exit failed 3 times consecutively for {data['symbol']}. Removing from active monitors to prevent gas drain.")
            self.send_alert(
                f"⚠️ *CRITICAL GAS DRAIN SHIELD: EXITED {data['symbol']}*\n"
                f"-----------------------------------------\n"
                f"• Exit swap failed 3 times consecutively ({reason}).\n"
                f"• De-registering from active monitors to prevent further gas fees. Please exit manually.\n"
                f"• Current price: ${price:.8f}"
            )
            # Log to history as exit_failed_repeatedly so we keep a record
            self.log_closed_position(token_addr_lower, price, "exit_failed_repeatedly")
            del self.active_monitors[token_addr_lower]
        
        self.save_active_positions()

    def log_closed_position(self, token_addr, exit_price, exit_reason):
        """Record a completed/closed trade position to a local trade_history.json log for ledger display"""
        try:
            import os
            import json
            import time
            
            history_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "trade_history.json")
            
            data = self.active_monitors.get(token_addr.lower())
            if not data:
                return
                
            history = []
            if os.path.exists(history_file):
                try:
                    with open(history_file, "r") as f:
                        history = json.load(f)
                except:
                    history = []
            
            entry = data["entry_price"]
            p_l_pct = ((exit_price - entry) / entry * 100.0) if entry > 0 else 0.0
            
            entry_size = data.get("entry_size_eth", 0.005)
            if exit_reason == "partial_take_profit" or data.get("is_derisked", False):
                entry_size = entry_size / 2.0

            buy_gas = data.get("buy_gas_eth")
            if buy_gas is None:
                buy_gas = 0.0000055
                
            sell_gas = getattr(self.trader, "last_gas_used_eth", 0.0)
            if sell_gas <= 0.0:
                sell_gas = 0.0000072
                
            total_gas_eth = buy_gas + sell_gas
            
            eth_price = 1868.79
            try:
                eth_pair = self.tracker.fetch_dex_stats("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2")
                if eth_pair:
                    eth_price = float(eth_pair.get("priceUsd", 1868.79))
            except:
                pass
                
            total_gas_usd = total_gas_eth * eth_price
            
            entry_usd = entry_size * eth_price
            exit_usd = entry_usd * (1 + (p_l_pct / 100.0))
            p_l_usd = exit_usd - entry_usd

            record = {
                "symbol": data["symbol"],
                "address": token_addr,
                "entry_price": entry,
                "exit_price": exit_price,
                "p_l_pct": p_l_pct,
                "max_mult": data["max_mult"],
                "exit_reason": exit_reason,
                "timestamp": time.time(),
                "entry_timestamp": data.get("timestamp", time.time() - 3600),
                "exit_timestamp": time.time(),
                "entry_size_eth": entry_size,
                "entry_usd": entry_usd,
                "exit_usd": exit_usd,
                "p_l_usd": p_l_usd,
                "eth_price_at_exit": eth_price,
                "buy_gas_eth": buy_gas,
                "sell_gas_eth": sell_gas,
                "total_gas_eth": total_gas_eth,
                "total_gas_usd": total_gas_usd
            }
            
            history.insert(0, record)
            history = history[:100] # keep last 100 trades
            
            with open(history_file, "w") as f:
                json.dump(history, f, indent=2)
            self.copy_to_public(history_file, 'trade_history.json')
            
            # Whale Alpha: Log performance statistics
            trigger_wallet = data.get("trigger_wallet_address")
            if trigger_wallet:
                try:
                    perf_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "wallet_performance.json")
                    perf_db = {}
                    if os.path.exists(perf_file):
                        try:
                            with open(perf_file, "r") as f:
                                perf_db = json.load(f)
                        except:
                            perf_db = {}
                    
                    wallet_key = trigger_wallet.lower()
                    if wallet_key not in perf_db:
                        perf_db[wallet_key] = {
                            "win_rate": 100.0,
                            "total_trades": 0,
                            "winning_trades": 0,
                            "losing_trades": 0,
                            "net_pnl_pct": 0.0
                        }
                    
                    perf_db[wallet_key]["total_trades"] += 1
                    if p_l_pct > 0:
                        perf_db[wallet_key]["winning_trades"] += 1
                    else:
                        perf_db[wallet_key]["losing_trades"] += 1
                    
                    perf_db[wallet_key]["net_pnl_pct"] += p_l_pct
                    total_t = perf_db[wallet_key]["total_trades"]
                    perf_db[wallet_key]["win_rate"] = (perf_db[wallet_key]["winning_trades"] / total_t) * 100.0
                    
                    with open(perf_file, "w") as f:
                        json.dump(perf_db, f, indent=2)
                    print(f"[Whale Alpha] Performance logged for {wallet_key[:8]}... Win Rate: {perf_db[wallet_key]['win_rate']:.1f}% ({total_t} trades).")
                except Exception as e:
                    print(f"[Whale Alpha] Failed to log whale performance record: {e}")
        except Exception as e:
            print(f"[Bot] Error writing trade history log: {str(e)}")

    def write_status_json(self, current_block):
        """Write periodic real-time status snapshot to a local JSON file for the Node Express server"""
        try:
            import os
            import json
            status_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bot_status.json")
            
            # Fetch balances only every 60 seconds to conserve RPC limits
            now = time.time()
            if not hasattr(self, 'cached_balances') or now - getattr(self, 'last_balance_query_time', 0) >= 60:
                try:
                    w3 = self.scanner.w3
                    native_bal = w3.from_wei(w3.eth.get_balance(self.trader.address), 'ether')
                    
                    weth_contract = w3.eth.contract(
                        address=w3.to_checksum_address(config.WETH_ADDRESS),
                        abi=self.scanner.erc20_abi
                    )
                    weth_bal = w3.from_wei(weth_contract.functions.balanceOf(self.trader.address).call(), 'ether')
                    
                    if float(native_bal) < 0.001 and float(weth_bal) >= 0.002:
                        print(f"[Gas Management] Low gas detected ({native_bal:.6f} ETH). Initiating auto-refuel from WETH portfolio...")
                        refuel_success = self.trader.unwrap_weth(0.0016)
                        if refuel_success:
                            native_bal = w3.from_wei(w3.eth.get_balance(self.trader.address), 'ether')
                            weth_bal = w3.from_wei(weth_contract.functions.balanceOf(self.trader.address).call(), 'ether')
                            print(f"[Gas Management] Auto-refuel complete. New native gas: {native_bal:.6f} ETH, WETH: {weth_bal:.6f}")
                    
                    self.cached_balances = {
                        "native_eth": float(native_bal),
                        "weth": float(weth_bal)
                    }
                    self.last_balance_query_time = now
                except Exception as e:
                    print(f"[Bot] Error querying balances for status JSON: {str(e)}")
                    if not hasattr(self, 'cached_balances'):
                        self.cached_balances = {"native_eth": 0.0, "weth": 0.0}
            
            goal_hit, today_gain = self.check_daily_profit_goal()
            snapshot = {
                "status": "active",
                "rpc_url": config.RPC_URL,
                "current_block": current_block,
                "wallet_address": self.trader.address,
                "last_update": now,
                "active_monitors_count": len(self.active_monitors),
                "balances": self.cached_balances,
                "daily_profit_goal_pct": config.DAILY_PROFIT_GOAL_PCT,
                "today_gain_pct": today_gain,
                "daily_profit_goal_hit": goal_hit
            }
            
            with open(status_file, "w") as f:
                json.dump(snapshot, f, indent=2)
            self.copy_to_public(status_file, 'bot_status.json')
            
            # --- COMPETITION REFEREE ENGINE ---
            try:
                # 1. Load Solana Paper Metrics
                solana_trades_file = "/Users/racs/clawd/projects/pumpfun-scanner/paper_trades.json"
                solana_stats = {
                    "balance_usd": 100.0,
                    "daily_gain_pct": 0.0,
                    "win_rate_pct": 0.0,
                    "total_trades": 0,
                    "daily_target_hit": False
                }
                if os.path.exists(solana_trades_file):
                    with open(solana_trades_file, "r") as sf:
                        s_data = json.load(sf)
                    s_stats = s_data.get("stats", {})
                    s_win_rate = (s_stats.get("winning_trades", 0) / s_stats.get("total_trades", 1) * 100.0) if s_stats.get("total_trades", 0) > 0 else 0.0
                    solana_stats = {
                        "balance_usd": float(s_data.get("balance", 100.0)),
                        "daily_gain_pct": float((s_data.get("balance", 100.0) - s_data.get("starting_balance", 100.0)) / s_data.get("starting_balance", 100.0) * 100.0),
                        "win_rate_pct": s_win_rate,
                        "total_trades": int(s_stats.get("total_trades", 0)),
                        "daily_target_hit": float(s_data.get("balance", 100.0)) >= float(s_data.get("starting_balance", 100.0)) * 1.5
                    }

                # 2. Fetch ETH price to compute Robinhood USD balance
                             # --- COMPETITION REFEREE ENGINE (CHALLENGE START: Aug 7, 2026 9:15 AM PST / 1786119300) ---
                CHALLENGE_START_TIME = 1786119300
                RH_STARTING_BALANCE = 77.39
                SOL_STARTING_BALANCE = 24.58

                # Fetch ETH price to compute Robinhood USD balance
                eth_price = 1868.79
                try:
                    eth_pair = self.tracker.fetch_dex_stats("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2")
                    if eth_pair:
                        eth_price = float(eth_pair.get("priceUsd", 1868.79))
                except:
                    pass

                rh_native = snapshot["balances"]["native_eth"]
                rh_weth = snapshot["balances"]["weth"]
                rh_balance_usd = (rh_native + rh_weth) * eth_price

                # Load Robinhood challenge metrics
                rh_win_rate = 0.0
                rh_total_trades = 0
                rh_daily_gain = 0.0
                rh_recent = []
                rh_history_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "trade_history.json")
                if os.path.exists(rh_history_file):
                    with open(rh_history_file, "r") as hf:
                        history = json.load(hf)
                    challenge_history = [t for t in history if t.get("timestamp", 0) >= CHALLENGE_START_TIME]
                    rh_total_trades = len(challenge_history)
                    rh_profitable = sum(1 for t in challenge_history if t.get("p_l_usd", 0) > 0)
                    rh_win_rate = (rh_profitable / rh_total_trades * 100.0) if rh_total_trades > 0 else 0.0
                    
                    # Net profit / starting balance
                    rh_net_pnl = sum((t.get("p_l_usd", 0) - t.get("total_gas_usd", 0)) for t in challenge_history)
                    rh_daily_gain = (rh_net_pnl / RH_STARTING_BALANCE * 100.0)
                    
                    # Extract last 5 challenge trades
                    for t in challenge_history[-5:]:
                        rh_recent.append({
                            "symbol": t.get("symbol", "N/A"),
                            "pnl_pct": float(t.get("p_l_pct", 0.0)),
                            "pnl_usd": float(t.get("p_l_usd", 0.0)),
                            "reason": t.get("exit_reason", "unknown")
                        })
                    rh_recent.reverse()

                    # Compile Robinhood Buy Candidates (Uniswap V3 discovered tokens)
                    rh_candidates = []
                    nl_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "new_launches.json")
                    if os.path.exists(nl_file):
                        try:
                            with open(nl_file, "r") as nlf:
                                nl_list = json.load(nlf)
                            active_keys = [a.lower() for a in self.active_monitors.keys()]
                            nl_filtered = [c for c in nl_list if c.get("address", "").lower() not in active_keys]
                            nl_filtered.sort(key=lambda x: float(x.get("lp_usd", 0.0)), reverse=True)
                            for c in nl_filtered[:3]:
                                lp = float(c.get("lp_usd", 0.0))
                                prog = min(99.0, (lp / 15000.0) * 100.0) if lp < 15000.0 else 95.0
                                rh_candidates.append({
                                    "symbol": c.get("symbol", "N/A"),
                                    "address": c.get("address", ""),
                                    "metric": f"LP: ${lp:,.0f} / $15K",
                                    "progress_pct": prog
                                })
                        except Exception as nle:
                            print(f"[Referee] Error compiling Robinhood candidates: {nle}")

                # Load Solana challenge metrics
                sol_balance_usd = solana_stats["balance_usd"]
                sol_total_trades = 0
                sol_win_rate = 0.0
                sol_daily_gain = 0.0
                sol_recent = []
                if os.path.exists(solana_trades_file):
                    try:
                        with open(solana_trades_file, "r") as sf:
                            s_data = json.load(sf)
                        closed_list = s_data.get("closed_trades", [])
                        
                        # Filter for challenge trades
                        sol_challenge_trades = []
                        from datetime import datetime
                        for t in closed_list:
                            try:
                                exit_time_str = t.get("exit_time")
                                if exit_time_str:
                                    exit_ts = datetime.fromisoformat(exit_time_str).timestamp()
                                    if exit_ts >= CHALLENGE_START_TIME:
                                        sol_challenge_trades.append(t)
                            except:
                                pass
                                
                        sol_total_trades = len(sol_challenge_trades)
                        sol_profitable = sum(1 for t in sol_challenge_trades if t.get("pnl_usd", 0) > 0)
                        sol_win_rate = (sol_profitable / sol_total_trades * 100.0) if sol_total_trades > 0 else 0.0
                        
                        sol_net_pnl = sum(float(t.get("pnl_usd", 0.0)) for t in sol_challenge_trades)
                        sol_daily_gain = (sol_net_pnl / SOL_STARTING_BALANCE * 100.0)
                        
                        # Extract last 5 challenge trades
                        for t in sol_challenge_trades[-5:]:
                            sol_recent.append({
                                "symbol": t.get("symbol", "N/A"),
                                "pnl_pct": float(t.get("pnl_pct", 0.0)) * 100.0,
                                "pnl_usd": float(t.get("pnl_usd", 0.0)),
                                "reason": t.get("close_reason", "unknown")
                            })
                        sol_recent.reverse()
                        
                        # Compile Solana Buy Candidates (pump.fun scanner hot coins)
                        sol_candidates = []
                        hc_file = "/Users/racs/clawd/projects/pumpfun-scanner/hot_coins.json"
                        if os.path.exists(hc_file):
                            try:
                                with open(hc_file, "r") as hcf:
                                    hc_list = json.load(hcf)
                                active_sol_addrs = [p.get("address", "").lower() for p in s_data.get("positions", [])]
                                hc_filtered = [c for c in hc_list if c.get("address", "").lower() not in active_sol_addrs]
                                hc_filtered.sort(key=lambda x: x.get("score", 0), reverse=True)
                                for c in hc_filtered[:3]:
                                    score = c.get("score", 0)
                                    prog = min(99.0, (score / 60.0) * 100.0)
                                    sol_candidates.append({
                                        "symbol": c.get("symbol", "N/A"),
                                        "address": c.get("address", ""),
                                        "metric": f"Graham Score: {score:.0f}/60",
                                        "progress_pct": prog
                                    })
                            except Exception as hce:
                                print(f"[Referee] Error compiling Solana candidates: {hce}")
                    except Exception as sol_ref_err:
                        print(f"[Referee] Error parsing Solana stats: {sol_ref_err}")

                competition_data = {
                    "last_update": now,
                    "robinhood": {
                        "label": "Robinhood Chain Bot (Live)",
                        "balance_usd": rh_balance_usd,
                        "daily_gain_pct": rh_daily_gain,
                        "win_rate_pct": rh_win_rate,
                        "total_trades": rh_total_trades,
                        "daily_target_hit": rh_daily_gain >= 50.0,
                        "recent_trades": rh_recent,
                        "candidates": rh_candidates if 'rh_candidates' in locals() else []
                    },
                    "solana": {
                        "label": "Solana Bot (Graham v3 Live)" if os.path.exists("/Users/racs/clawd/projects/pumpfun-scanner/.env.solana") else "Solana Bot (Graham v3 Paper)",
                        "balance_usd": sol_balance_usd,
                        "daily_gain_pct": sol_daily_gain,
                        "win_rate_pct": sol_win_rate,
                        "total_trades": sol_total_trades,
                        "daily_target_hit": sol_daily_gain >= 50.0,
                        "recent_trades": sol_recent,
                        "candidates": sol_candidates if 'sol_candidates' in locals() else []
                    }
                }
                
                comp_file = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public", "competition_status.json")
                with open(comp_file, "w") as cf:
                    json.dump(competition_data, cf, indent=2)
            except Exception as referee_err:
                print(f"[Bot] Competition Referee error: {referee_err}")
        except Exception as e:
            print(f"[Bot] Error writing status JSON: {str(e)}")

    def copy_to_public(self, local_path, filename):
        """Helper to copy generated data file directly to Express server public directory"""
        try:
            import shutil
            public_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public")
            if os.path.exists(public_dir):
                dest_path = os.path.join(public_dir, filename)
                shutil.copy(local_path, dest_path)
        except Exception as e:
            print(f"[Bot] Error copying {filename} to public directory: {str(e)}")

    async def telegram_listener_loop(self):
        """Asynchronous background loop to poll and execute interactive Telegram commands"""
        if config.TELEGRAM_BOT_TOKEN == "YOUR_BOT_TOKEN_HERE" or config.TELEGRAM_CHAT_ID == "YOUR_CHAT_ID_HERE":
            print("[Telegram] Bot token or chat ID is not configured. Listener loop disabled.")
            return

        import aiohttp
        url = f"https://api.telegram.org/bot{config.TELEGRAM_BOT_TOKEN}/getUpdates"
        offset = 0
        
        # Resolve offset on startup by getting the latest update first (ignores past commands)
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, params={"limit": 1, "timeout": 0}) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        if data.get("result"):
                            offset = data["result"][-1]["update_id"] + 1
                            print(f"[Telegram] Initialized offset to {offset} (ignoring older messages)")
        except Exception as e:
            print(f"[Telegram] Error resolving initial updates offset: {str(e)}")

        print("[Telegram] Interactive command listener started.")
        while True:
            try:
                async with aiohttp.ClientSession() as session:
                    params = {"offset": offset, "timeout": 30}
                    async with session.get(url, params=params, timeout=35) as resp:
                        if resp.status != 200:
                            await asyncio.sleep(5)
                            continue
                            
                        data = await resp.json()
                        for update in data.get("result", []):
                            offset = update["update_id"] + 1
                            message = update.get("message", {})
                            chat_id = str(message.get("chat", {}).get("id", ""))
                            
                            # Strict sender authorization check
                            if chat_id != str(config.TELEGRAM_CHAT_ID):
                                continue
                                
                            text = message.get("text", "").strip()
                            if not text.startswith("/"):
                                continue
                                
                            # Process Command asynchronously
                            asyncio.create_task(self.handle_telegram_command(text))
            except asyncio.CancelledError:
                break
            except Exception as e:
                print(f"[Telegram] Error in listener loop: {str(e)}")
                await asyncio.sleep(5)

    async def handle_telegram_command(self, text):
        """Execute commands received from Telegram"""
        parts = text.split()
        cmd = parts[0].lower()
        print(f"[Telegram] Received command: {cmd}")
        
        if cmd in ["/status", "/positions"]:
            try:
                # 1. Fetch Balances
                native_bal = self.scanner.w3.from_wei(self.scanner.w3.eth.get_balance(self.trader.address), 'ether')
                weth_contract = self.scanner.w3.eth.contract(
                    address=self.scanner.w3.to_checksum_address(config.WETH_ADDRESS),
                    abi=self.trader.erc20_abi
                )
                weth_bal = self.scanner.w3.from_wei(weth_contract.functions.balanceOf(self.trader.address).call(), 'ether')
                
                # 2. Build Monitor details
                lines = []
                for addr, data in self.active_monitors.items():
                    pair_data = self.tracker.fetch_dex_stats(addr)
                    price_str = "Unknown"
                    mult_str = f"{data['max_mult']:.1f}x"
                    if pair_data:
                        price = float(pair_data.get("priceUsd", 0))
                        price_str = f"${price:.8f}"
                        initial_price = data['prices'][0]
                        mult = price / initial_price if initial_price > 0 else 1.0
                        mult_str = f"{mult:.1f}x"
                    lines.append(f"▪️ *{data['symbol']}*: {price_str} ({mult_str} from entry) | De-risk TP: {data.get('de_risk_target', 2.0)}x")
                
                active_str = "\n".join(lines) if lines else "None"
                
                msg = (
                    f"📊 *TELEGRAM COMMAND CENTER STATUS*\n"
                    f"-----------------------------------------\n"
                    f"💼 *Wallet balances:*\n"
                    f"▪️ Native ETH: {native_bal:.6f} ETH\n"
                    f"▪️ WETH:       {weth_bal:.6f} WETH\n\n"
                    f"🔥 *Active Position Monitors:*\n"
                    f"{active_str}\n"
                    f"-----------------------------------------\n"
                    f"🔍 Listening for Robinhood Chain deployments..."
                )
                self.send_alert(msg)
            except Exception as e:
                self.send_alert(f"❌ Error fetching status: {str(e)}")

        elif cmd == "/buy":
            if len(parts) < 2:
                self.send_alert("⚠️ Usage: `/buy [token_address]`")
                return
                
            token_addr = self.scanner.w3.to_checksum_address(parts[1])
            self.send_alert(f"💸 *Initiating manual swap for target token...*\nAddress: `{token_addr}`")
            
            try:
                # 1. Fetch pair data from DexScreener to get labels and pool details
                w3 = self.scanner.w3
                pair_data = self.tracker.fetch_dex_stats(token_addr)
                labels = pair_data.get("labels", []) if pair_data else []
                dex_version = 'v2' if 'v2' in labels else 'v3'
                
                # Get token metadata
                token_contract = w3.eth.contract(address=token_addr, abi=self.scanner.erc20_abi)
                symbol = token_contract.functions.symbol().call()
                
                # Resolve pool details dynamically
                pool_fee = 10000
                pool_addr = None
                
                if dex_version == 'v2':
                    pool_addr = pair_data.get("pairAddress", "") if pair_data else None
                    self.send_alert(f"▪️ Symbol: {symbol}\n▪️ AMM: Uniswap V2\n▪️ Pool: `{pool_addr}`\n▪️ Amount: {config.TRADE_AMOUNT_ETH} ETH")
                else:
                    factory_abi = [{
                        "inputs": [
                            {"name": "tokenA", "type": "address"},
                            {"name": "tokenB", "type": "address"},
                            {"name": "fee", "type": "uint24"}
                        ],
                        "name": "getPool",
                        "outputs": [{"name": "", "type": "address"}],
                        "type": "function"
                    }]
                    factory = w3.eth.contract(
                        address=w3.to_checksum_address(config.UNISWAP_V3_FACTORY),
                        abi=factory_abi
                    )
                    best_pool = None
                    best_liquidity = -1
                    best_fee = 3000
                    
                    for fee in [10000, 3000, 500]:
                        try:
                            p_addr = factory.functions.getPool(
                                w3.to_checksum_address(token_addr),
                                w3.to_checksum_address(config.WETH_ADDRESS),
                                fee
                            ).call()
                            if p_addr and p_addr != "0x0000000000000000000000000000000000000000":
                                pool_contract = w3.eth.contract(
                                    address=w3.to_checksum_address(p_addr),
                                    abi=[{"inputs": [], "name": "liquidity", "outputs": [{"internalType": "uint128", "name": "", "type": "uint128"}], "stateMutability": "view", "type": "function"}]
                                )
                                liq = pool_contract.functions.liquidity().call()
                                if liq > best_liquidity:
                                    best_liquidity = liq
                                    best_pool = p_addr
                                    best_fee = fee
                        except Exception as e:
                            print(f"[Manual Resolution] Error checking pool for fee {fee}: {str(e)}")
                            continue
                            
                    if best_pool:
                        pool_fee = best_fee
                        pool_addr = best_pool
                    self.send_alert(f"▪️ Symbol: {symbol}\n▪️ AMM: Uniswap V3 ({pool_fee / 10000:.2f}%)\n▪️ Pool: `{pool_addr}`\n▪️ Amount: {config.TRADE_AMOUNT_ETH} ETH")

                if not pool_addr:
                    self.send_alert("❌ Could not locate active Uniswap pool for target token with WETH.")
                    return
                    
                # Sizing details (Dynamic compounding based on active WETH balance)
                weth_contract = w3.eth.contract(
                    address=w3.to_checksum_address(config.WETH_ADDRESS),
                    abi=self.trader.erc20_abi
                )
                weth_bal = w3.from_wei(weth_contract.functions.balanceOf(self.trader.address).call(), 'ether')
                
                standard_size_eth = float(weth_bal) * (getattr(config, "BASE_TRADE_SIZE_PCT", 15.0) / 100.0)
                standard_size_eth = min(standard_size_eth, getattr(config, "MAX_TRADE_AMOUNT_ETH", 0.05))
                sizing_eth = max(standard_size_eth, config.TRADE_AMOUNT_ETH) # Floor fallback
                
                if weth_bal >= sizing_eth:
                    self.send_alert("▪️ WETH balance is sufficient. Skipping wrapping.")
                else:
                    needed = sizing_eth - float(weth_bal)
                    self.send_alert(f"▪️ Wrapping {needed:.6f} native ETH to WETH...")
                    self.trader.wrap_eth(needed)
                
                # Swapping WETH for target token
                self.send_alert(f"▪️ Executing buy swap on Uniswap {dex_version.upper()} router...")
                amount_wei = w3.to_wei(sizing_eth, 'ether')
                min_out = self.calculate_slippage_limit(token_addr, amount_wei, is_buy=True)
                buy_success = self.trader.execute_swap(
                    token_in=w3.to_checksum_address(config.WETH_ADDRESS),
                    token_out=token_addr,
                    amount_in=amount_wei,
                    pool_fee=pool_fee,
                    amount_out_minimum=min_out,
                    dex_version=dex_version
                )
                
                if buy_success:
                    initial_price = float(pair_data.get("priceUsd", 0)) if pair_data else 0.0
                    entry_price = initial_price if initial_price > 0 else 0.0001
                    try:
                        eth_pair = self.tracker.fetch_dex_stats("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2")
                        eth_price = float(eth_pair.get("priceUsd", 1800.0)) if eth_pair else 1800.0
                        if pool_addr:
                            onchain_price = self.get_onchain_price(token_addr.lower(), config.WETH_ADDRESS, pool_addr.lower(), dex_version=dex_version)
                            if onchain_price > 0.0:
                                entry_price = onchain_price * eth_price
                                print(f"[Trader] Overrode manual entry price to on-chain fill: ${entry_price:.8f}")
                    except Exception as e:
                        print(f"[Trader] Error resolving immediate manual entry price on-chain: {str(e)}")
                    
                    # Resolve dynamic stop loss multiplier based on pool liquidity
                    lp_usd = float(pair_data.get("liquidity", {}).get("usd", 0) or 0) if pair_data else 0.0
                    stop_loss_mult = 0.85
                    if lp_usd < 15000.0:
                        stop_loss_mult = 0.80
                    elif lp_usd < 35000.0:
                        stop_loss_mult = 0.85
                    else:
                        stop_loss_mult = 0.90
                        
                    self.active_monitors[token_addr.lower()] = {
                        'prices': [entry_price],
                        'volumes': [0.0],
                        'symbol': symbol,
                        'max_mult': 1.0,
                        'entry_price': entry_price,
                        'ath_price': entry_price,
                        'is_derisked': False,
                        'base_addr': w3.to_checksum_address(config.WETH_ADDRESS).lower(),
                        'pool_fee': pool_fee,
                        'pool_addr': pool_addr.lower() if pool_addr else None,
                        'dex_version': dex_version,
                        'buy_success': True,
                        'conviction_tier': 2,
                        'de_risk_target': 2.0,
                        'entry_size_eth': float(sizing_eth),
                        'stop_loss_mult': stop_loss_mult,
                        'buy_gas_eth': float(self.trader.last_gas_used_eth),
                        'timestamp': int(time.time())
                    }
                    self.save_active_positions()
                    self.send_alert(f"✅ *SUCCESSFULLY BOUGHT {symbol}!* Live tracking active.")
                else:
                    self.send_alert("❌ Swap execution failed or reverted.")
            except Exception as e:
                self.send_alert(f"❌ Swap failed: {str(e)}")

        elif cmd == "/sell":
            if len(parts) < 2:
                self.send_alert("⚠️ Usage: `/sell [token_address]`")
                return
                
            token_addr = self.scanner.w3.to_checksum_address(parts[1])
            monitored_data = self.active_monitors.get(token_addr.lower())
            
            if not monitored_data:
                self.send_alert("⚠️ Token is not currently in active positions monitor.")
                return
                
            self.send_alert(f"🚨 *Initiating manual sell exit for {monitored_data['symbol']}...*")
            try:
                # Fetch balance
                token_bal = self.trader.get_token_balance(token_addr)
                if token_bal == 0:
                    self.send_alert("⚠️ Wallet token balance is already 0.")
                    return
                    
                # Execute sell swap
                min_out = self.calculate_slippage_limit(token_addr, token_bal, is_buy=False)
                sell_success = self.trader.execute_swap(
                    token_in=token_addr,
                    token_out=self.scanner.w3.to_checksum_address(monitored_data['base_addr']),
                    amount_in=token_bal,
                    pool_fee=monitored_data['pool_fee'],
                    amount_out_minimum=min_out,
                    dex_version=monitored_data.get('dex_version', 'v3')
                )
                
                if sell_success:
                    exit_price = monitored_data['prices'][-1] if monitored_data.get('prices') else monitored_data.get('entry_price', 0.0)
                    self.log_closed_position(token_addr.lower(), exit_price, "manual_sell")
                    del self.active_monitors[token_addr.lower()]
                    self.save_active_positions()
                    self.send_alert(f"✅ *SUCCESSFULLY EXITED {monitored_data['symbol']} POSITION.*")
                else:
                    self.send_alert("❌ Sell swap execution failed or reverted.")
            except Exception as e:
                self.send_alert(f"❌ Sell failed: {str(e)}")

    def check_smart_money_transactions(self, block_num):
        """Monitor block transactions for any swap activity from our tracked wallets list"""
        try:
            w3 = self.scanner.w3
            block = w3.eth.get_block(block_num, full_transactions=True)
            for tx in block.transactions:
                from_addr = tx.get('from', '').lower()
                if from_addr in self.tracked_wallets:
                    label = self.tracked_wallets[from_addr]
                    tx_hash = tx['hash'].hex()
                    
                    receipt = w3.eth.get_transaction_receipt(tx['hash'])
                    if receipt.status != 1:
                        continue
                        
                    transfers = []
                    transfer_event_hash = w3.keccak(text="Transfer(address,address,uint256)").hex()
                    
                    for log in receipt.logs:
                        if len(log.topics) == 4 and log.topics[0].hex() == transfer_event_hash:
                            # ERC-721 NFT Transfer log
                            if getattr(config, "COPY_TRADE_NFTS", False):
                                from_log = '0x' + log.topics[1].hex()[-40:]
                                to_log = '0x' + log.topics[2].hex()[-40:]
                                contract_addr = log.address.lower()
                                
                                # Check if it's a mint event (from 0x0000...)
                                if from_log == '0x0000000000000000000000000000000000000000':
                                    if to_log.lower() == from_addr:
                                        tx_value = tx.get('value', 0)
                                        tx_input = tx.get('input', '0x')
                                        tx_to = tx.get('to', '')
                                        
                                        asyncio.run_coroutine_threadsafe(
                                            self.execute_copy_mint(tx_to, tx_value, tx_input, label, tx_hash),
                                            self.loop
                                        )
                        elif len(log.topics) == 3 and log.topics[0].hex() == transfer_event_hash:
                            # ERC-20 Token Transfer log
                            from_log = '0x' + log.topics[1].hex()[-40:]
                            to_log = '0x' + log.topics[2].hex()[-40:]
                            contract = log.address.lower()
                            
                            amount = int(log.data.hex(), 16) if log.data else 0
                            transfers.append({
                                'from': from_log.lower(),
                                'to': to_log.lower(),
                                'contract': contract,
                                'amount': amount
                            })
                            
                    weth_spent = 0
                    weth_received = 0
                    token_contract_addr = None
                    token_amount = 0
                    
                    for tf in transfers:
                        if tf['contract'] == config.WETH_ADDRESS.lower():
                            if tf['from'] == from_addr:
                                weth_spent += tf['amount']
                            elif tf['to'] == from_addr:
                                weth_received += tf['amount']
                        else:
                            if tf['to'] == from_addr:
                                token_contract_addr = tf['contract']
                                token_amount = tf['amount']
                            elif tf['from'] == from_addr:
                                token_contract_addr = tf['contract']
                                token_amount = tf['amount']
                                
                    if token_contract_addr:
                        try:
                            token_contract = w3.eth.contract(
                                address=w3.to_checksum_address(token_contract_addr),
                                abi=self.scanner.erc20_abi
                            )
                            symbol = token_contract.functions.symbol().call()
                            name = token_contract.functions.name().call()
                            decimals = token_contract.functions.decimals().call()
                            formatted_amount = token_amount / (10 ** decimals)
                        except:
                            symbol = "UNKNOWN"
                            name = "Unknown Token"
                            formatted_amount = token_amount
                            
                        if symbol == "WETH" or symbol == "UNKNOWN":
                            continue
                            
                        pair_data = self.tracker.fetch_dex_stats(token_contract_addr)
                        price = float(pair_data.get("priceUsd", 0) if pair_data else 0.0)
                        
                        # Case 1: BUY swap detected (tracked wallet spent WETH)
                        if weth_spent > weth_received:
                            net_weth = weth_spent - weth_received
                            formatted_weth = w3.from_wei(net_weth, 'ether')
                            
                            self.send_alert(
                                f"🕵️‍♂️ *SMART MONEY INFLOW DETECTED!*\n"
                                f"-----------------------------------------\n"
                                f"• Wallet: *{label}*\n"
                                f"• Address: `{from_addr[:6]}...{from_addr[-4:]}`\n"
                                f"• Swap: Bought *{formatted_amount:,.2f} {symbol}* for *{formatted_weth:.4f} WETH*\n"
                                f"• Tx Hash: [View Transaction](https://explorer.chain.robinhood.com/tx/{tx_hash})\n"
                                f"-----------------------------------------\n"
                                f"📥 Automatically adding {symbol} to Watchlist..."
                            )
                            
                            if token_contract_addr not in self.watchlist:
                                self.watchlist[token_contract_addr] = {
                                    'symbol': symbol,
                                    'name': name,
                                    'target_reclaim_price': 0.0,
                                    'last_bottom_price': price if price > 0 else 0.0
                                }
                                self.save_watchlist()
                                
                            # If eligible for copy trade, trigger copy buy
                            if self.is_copy_trade_eligible(from_addr):
                                asyncio.run_coroutine_threadsafe(
                                    self.execute_copy_buy(token_contract_addr, symbol, name, label, pair_data, from_addr),
                                    self.loop
                                )
                                
                        # Case 2: SELL swap detected (tracked wallet received WETH)
                        elif weth_received > weth_spent:
                            net_weth = weth_received - weth_spent
                            formatted_weth = w3.from_wei(net_weth, 'ether')
                            
                            self.send_alert(
                                f"🕵️‍♂️ *SMART MONEY OUTFLOW DETECTED!*\n"
                                f"-----------------------------------------\n"
                                f"• Wallet: *{label}*\n"
                                f"• Address: `{from_addr[:6]}...{from_addr[-4:]}`\n"
                                f"• Swap: Sold *{formatted_amount:,.2f} {symbol}* for *{formatted_weth:.4f} WETH*\n"
                                f"• Tx Hash: [View Transaction](https://explorer.chain.robinhood.com/tx/{tx_hash})\n"
                                f"-----------------------------------------\n"
                            )
                            
                            # If eligible for copy trade and we have an active position, trigger copy sell exit
                            if self.is_copy_trade_eligible(from_addr) and token_contract_addr in self.active_monitors:
                                asyncio.run_coroutine_threadsafe(
                                    self.execute_copy_sell(token_contract_addr, symbol, label),
                                    self.loop
                                )
        except Exception as e:
            print(f"[Smart Money] Error parsing block {block_num}: {str(e)}")

    async def scan_loop(self):
        """Primary execution loop"""
        import sys
        self.loop = asyncio.get_running_loop()
        print("[Bot] Initializing scan daemon loop on Robinhood Chain RPC...")
        self.optimizer.optimize()
        
        # Start background metrics auditor loop
        asyncio.create_task(self.background_metrics_audit_loop())
        
        # Start Telegram listener loop in the background
        asyncio.create_task(self.telegram_listener_loop())
        
        run_sim = "--simulate" in sys.argv
        if run_sim:
            print("🟠 Running in simulation mode (--simulate flag detected)...")
            await self._run_simulation()
            return
            
        # Safe connection retry loop for live production runs
        while not self.scanner.is_connected():
            print(f"⚠️ RPC Node {config.RPC_URL} is offline or rate-limited. Retrying in 10 seconds...")
            await asyncio.sleep(10)
            
        w3 = self.scanner.w3
        print(f"🟢 Connected to RPC Node: {config.RPC_URL}")
        
        # Calculate event topic0 dynamically
        pool_created_topic = w3.keccak(text="PoolCreated(address,address,uint24,int24,address)")
        print(f"[Scanner] Listening for Uniswap V3 PoolCreated events (Topic0: {pool_created_topic.hex()})")
        
        latest_block = w3.eth.block_number
        print(f"[Scanner] Current block: {latest_block}. Sweeping last 50 blocks for recent launches...")
        
        try:
            logs = w3.eth.get_logs({
                'fromBlock': max(0, latest_block - 50),
                'toBlock': latest_block,
                'address': w3.to_checksum_address(config.UNISWAP_V3_FACTORY),
                'topics': [pool_created_topic]
            })
            print(f"[Scanner] Sweep complete. Found {len(logs)} recent token pools.")
            for log in logs:
                self.process_pool_log(log)
        except Exception as e:
            print(f"[Scanner] Historical sweep failed (RPC limitation or no logs): {str(e)}")
            
        print("[Scanner] Listening for live block events. Monitoring active...")
        
        while True:
            try:
                current_block = w3.eth.block_number
                if current_block > latest_block:
                    logs = w3.eth.get_logs({
                        'fromBlock': latest_block + 1,
                        'toBlock': current_block,
                        'address': w3.to_checksum_address(config.UNISWAP_V3_FACTORY),
                        'topics': [pool_created_topic]
                    })
                    for log in logs:
                        asyncio.create_task(asyncio.to_thread(self.process_pool_log, log))
                        
                    # Check smart money transactions for new blocks asynchronously (limit queue size to 5)
                    smart_money_start = max(latest_block + 1, current_block - 5)
                    for b_num in range(smart_money_start, current_block + 1):
                        asyncio.create_task(asyncio.to_thread(self.check_smart_money_transactions, b_num))
                        
                    latest_block = current_block
            except Exception as e:
                print(f"[Scanner] Block sweep error: {str(e)}")
                
            await self.update_active_monitors()
            
            # Run watchlist reclaims check every 30 seconds to conserve API limits
            if not hasattr(self, 'last_watchlist_check_time') or time.time() - self.last_watchlist_check_time >= 30:
                await self.check_watchlist_reclaims()
                self.last_watchlist_check_time = time.time()
                
            await self.check_high_cap_momentum()
            await self.check_pending_launches()
            
            # Dispatch high-cap momentum summaries every 5 minutes (300 seconds)
            if time.time() - self.last_momentum_dispatch >= 300:
                await self.dispatch_momentum_summary()
                self.last_momentum_dispatch = time.time()
            
            # Write dashboard stats file
            self.write_status_json(latest_block)
            
            # Check 10-minute Heartbeat / Active Summary (600 seconds)
            if time.time() - self.last_heartbeat_time >= 600:
                await self.send_periodic_summary()
                self.last_heartbeat_time = time.time()
                
            await asyncio.sleep(5)

if __name__ == "__main__":
    bot = TelegramBot()
    asyncio.run(bot.scan_loop())
