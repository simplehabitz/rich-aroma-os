import os
from dotenv import load_dotenv

# Load workspace env variables
load_dotenv(dotenv_path=os.path.join(os.path.dirname(os.path.dirname(__file__)), '.env.production'))

# RPC Connection settings
# Robinhood Wallet relies primarily on Arbitrum One L2 for low-cost token deployments.
# We default to public Arbitrum RPCs, but make it fully overrideable.
RPC_URL = os.getenv("ROBINHOOD_RPC_URL", "https://rpc.mainnet.chain.robinhood.com") 

# Uniswap V3 Factory Address on Robinhood Chain
UNISWAP_V3_FACTORY = os.getenv("UNISWAP_V3_FACTORY", "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA")

# WETH (aeWETH token proxy) on Robinhood Chain
WETH_ADDRESS = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"

# Telegram Alerts Settings
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "YOUR_BOT_TOKEN_HERE")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "YOUR_CHAT_ID_HERE")

# Discord Alerts Settings
DISCORD_WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL", "YOUR_DISCORD_WEBHOOK_HERE")

# Automated Trading Settings
TRADE_EXECUTION_ENABLED = os.getenv("TRADE_EXECUTION_ENABLED", "false").lower() == "true"
TRADE_PRIVATE_KEY = os.getenv("TRADE_PRIVATE_KEY", "")
TRADE_AMOUNT_ETH = float(os.getenv("TRADE_AMOUNT_ETH", "0.0015"))
MIN_TRADING_BALANCE_ETH = 0.0015  # Adjust floor to allow trading with 0.0015 WETH

# Copy Trading Settings
COPY_TRADE_SMART_MONEY = os.getenv("COPY_TRADE_SMART_MONEY", "true").lower() == "true"
COPY_TRADE_WALLETS = [
    "0x3ffd797746452a2558cf8278ac11678b18870cac",
    "0xdbd47f66aa2f00b3db03397f260ce9728298c495"
]
AUTO_COPY_MIN_WIN_RATE = float(os.getenv("AUTO_COPY_MIN_WIN_RATE", "65.0"))
AUTO_COPY_MIN_TRADES = int(os.getenv("AUTO_COPY_MIN_TRADES", "3"))

# Moonbag Strategy Parameters
TAKE_PROFIT_MULTIPLIER = 1.30   # Legacy parameter
TAKE_PROFIT_1_MULTIPLIER = 1.12 # Sell 40% portion at 1.12x price
TAKE_PROFIT_2_MULTIPLIER = 1.30 # Sell 30% portion at 1.30x price (leaving 30% moonbag)
TRAILING_STOP_THRESHOLD = 0.85  # Exit moonbag if price drops 15% from its ATH
STOP_LOSS_MULTIPLIER = 0.8     # Stop loss triggers if price falls below 80% of entry
TIME_STOP_SECONDS = 7200        # 2 hours maximum hold time
MAX_BUY_SELL_RATIO = 3.0       # Max buys/sells ratio in h1 to check for honeypots
MIN_BUYBACK_LIQUIDITY_USD = 10000.0  # Min liquidity required to buyback a watchlisted token
CIRCUIT_BREAKER_DAILY_LOSS_PCT = 50.0  # Max daily loss percentage allowed before circuit breaker triggers
DAILY_PROFIT_GOAL_PCT = 50.0  # Target % gain on starting daily capital to lock in profit and halt new trades
MAX_CONCURRENT_POSITIONS = 3  # Limit concurrent active trades to prevent risk-splitting/dilution
BASE_TRADE_SIZE_PCT = 15.0  # Risk 15% of liquid balance per trade by default
MAX_TRADE_AMOUNT_ETH = 0.05  # Cap maximum trade size at 0.05 ETH to avoid excessive risk
MAX_DAILY_DRAWDOWN_PCT = 20.0  # Trigger lockout if portfolio value drops 20% below today's peak (tracked in native ETH)

# NFT Copy-Trading Settings
COPY_TRADE_NFTS = True
MAX_NFT_MINT_PRICE_ETH = 0.005  # Cap copy-mint cost at 0.005 ETH

# Uniswap V3 Swap Router on Robinhood Chain (custom deployment)
SWAP_ROUTER_ADDRESS = os.getenv("SWAP_ROUTER_ADDRESS", "0xcaf681a66d020601342297493863e78c959e5cb2")

# Supabase database config (Inherits from website configuration)
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_ANON_KEY")

# Detection Thresholds (Default constants)
DEFAULT_MIN_LIQUIDITY_USD = float(os.getenv("MIN_LIQUIDITY_USD", 10000.0))
DEFAULT_VELOCITY_THRESHOLD = int(os.getenv("VELOCITY_THRESHOLD", 200))
DEFAULT_MAX_INSIDER_HOLDING = float(os.getenv("MAX_INSIDER_HOLDING", 50.0))

# Dynamic values (will load from optimized_parameters.json if optimization has run)
MIN_LIQUIDITY_USD = DEFAULT_MIN_LIQUIDITY_USD
VELOCITY_THRESHOLD = DEFAULT_VELOCITY_THRESHOLD
MAX_INSIDER_HOLDING = DEFAULT_MAX_INSIDER_HOLDING

# Attempt to load optimized values
opt_path = os.path.join(os.path.dirname(__file__), 'optimized_parameters.json')
if os.path.exists(opt_path):
    import json
    try:
        with open(opt_path, 'r') as f:
            opt_data = json.load(f)
            MIN_LIQUIDITY_USD = float(opt_data.get("MIN_LIQUIDITY_USD", DEFAULT_MIN_LIQUIDITY_USD))
            VELOCITY_THRESHOLD = int(opt_data.get("VELOCITY_THRESHOLD", DEFAULT_VELOCITY_THRESHOLD))
            MAX_INSIDER_HOLDING = float(opt_data.get("MAX_INSIDER_HOLDING", DEFAULT_MAX_INSIDER_HOLDING))
            print(f"[Config] Loaded optimized thresholds: LP=${MIN_LIQUIDITY_USD:,.0f}, Velocity={VELOCITY_THRESHOLD} tr/hr, Insider={MAX_INSIDER_HOLDING}%")
    except Exception as e:
        print(f"[Config] Error loading optimized thresholds: {str(e)}")

