# Smart Money Tracker - API Requirements & Roadmap

## Currently Used APIs

### 1. CoinGecko (Free Tier)
- **Used for:** Market overview, token search, price history, token metadata
- **Endpoints:** `/coins/markets`, `/search`, `/coins/{id}`, `/simple/price`, `/coins/{id}/market_chart`
- **Limitations:** 10-30 calls/min, rate limited
- **Data provided:** Price, market cap, volume, social links, platform addresses

### 2. Moralis (Free Tier)
- **Used for:** EVM token holders, wallet portfolios, transaction history
- **Endpoints:** `/erc20/{address}/owners`, `/wallets/{address}/tokens`, `/wallets/{address}/history`
- **Limitations:** Top 100 holders only, rate limited
- **Data provided:** Holder addresses, balances, wallet portfolios

### 3. GeckoTerminal (Free, No Key)
- **Used for:** DEX trades, liquidity pools
- **Endpoints:** `/networks/{id}/tokens/{address}/pools`, `/networks/{id}/pools/{address}/trades`
- **Limitations:** 30 req/min
- **Data provided:** Pool liquidity, 24h volume, recent trades, buy/sell counts

---

## APIs Needed for Full Features

### Priority 1: Complete Holder Data
**Problem:** Moralis only returns top 100 holders

| API Option | Pros | Cons | Cost |
|------------|------|------|------|
| **Covalent** | Full holder list, good coverage | Rate limits | Free tier available |
| **Alchemy** | Reliable, fast | Limited to certain chains | Free tier |
| **Dune Analytics** | Complete data, SQL queries | Slower, requires setup | Free tier |
| **Etherscan/Similar** | Accurate | Per-chain, no aggregation | Free/Paid |
| **Bitquery** | GraphQL, multi-chain | Complex setup | Paid |

**Recommendation:** Covalent or Dune for complete holder counts

---

### Priority 2: Wallet PnL / Trading Performance
**Problem:** Need historical trade data with entry/exit prices

| API Option | Pros | Cons | Cost |
|------------|------|------|------|
| **Moralis Streams** | Real-time tracking | Need to build history | Paid |
| **Zerion** | Good PnL data | Limited API access | Paid |
| **DeBank** | Excellent portfolio data | No public API | N/A |
| **Nansen** | Best smart money data | Expensive | $$$$ |
| **Arkham** | Entity labeling, PnL | Expensive | $$$ |

**Recommendation:** Build historical tracking with Moralis Streams, or integrate Zerion API

---

### Priority 3: Solana Support
**Problem:** Current Moralis Solana endpoints not working reliably

| API Option | Pros | Cons | Cost |
|------------|------|------|------|
| **Helius** | Best Solana API | Solana only | Free tier |
| **Shyft** | Good coverage | Newer | Free tier |
| **Solscan API** | Reliable | Rate limited | Free |
| **Jupiter API** | DEX data | Swaps only | Free |

**Recommendation:** Helius for comprehensive Solana support

---

### Priority 4: Real-time Data / Alerts
**Problem:** Need websocket/streaming for live updates

| API Option | Use Case | Cost |
|------------|----------|------|
| **Moralis Streams** | EVM transaction monitoring | Paid |
| **Alchemy Notify** | Webhook alerts | Free tier |
| **QuickNode Streams** | Multi-chain streaming | Paid |
| **The Graph** | Indexed blockchain data | Free/Paid |

---

### Priority 5: Smart Money / Entity Labeling
**Problem:** Identifying known wallets (exchanges, funds, whales)

| API Option | Pros | Cons | Cost |
|------------|------|------|------|
| **Arkham** | Best labeling | Very expensive | $$$$ |
| **Nansen** | Industry standard | Very expensive | $$$$ |
| **Etherscan Labels** | Free labels | Limited coverage | Free |
| **Custom Database** | Full control | Requires curation | Time |

**Recommendation:** Start with Etherscan labels, build custom database over time

---

## Implementation Roadmap

### Phase 5 (Next)
- [ ] Integrate Helius for Solana holder data
- [ ] Add Covalent for complete EVM holder counts
- [ ] Improve holder distribution accuracy

### Phase 6
- [ ] Wallet PnL tracking (requires historical data)
- [ ] Top traders leaderboard
- [ ] Real-time alerts setup

### Phase 7
- [ ] Entity labeling (exchanges, known wallets)
- [ ] Smart money tracking
- [ ] Advanced analytics

---

## Environment Variables Needed

```env
# Currently used
MORALIS_API_KEY=xxx
COINGECKO_API_KEY=xxx (optional, improves rate limits)

# Future additions
COVALENT_API_KEY=xxx
HELIUS_API_KEY=xxx
ALCHEMY_API_KEY=xxx
DUNE_API_KEY=xxx
```

---

## Notes

- Free tier APIs are sufficient for MVP but will need upgrades for production scale
- Multi-chain aggregation increases API calls significantly
- Consider caching layer (Redis) for production
- Rate limiting middleware recommended for high traffic
