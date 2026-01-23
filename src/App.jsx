import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';

// ============================================
// THEME - Minimal Dark (Pendle/DeFi Edge inspired)
// ============================================

const THEME = {
  // Backgrounds
  bg: {
    primary: '#0d1117',
    secondary: '#161b22',
    tertiary: '#21262d',
    card: '#161b22',
    hover: '#1f2428',
  },
  // Text
  text: {
    primary: '#e6edf3',
    secondary: '#8b949e',
    muted: '#6e7681',
  },
  // Accents
  accent: {
    primary: '#c41e5c',      // Pendle pink
    secondary: '#58a6ff',    // Blue link
    success: '#3fb950',
    warning: '#d29922',
    error: '#f85149',
  },
  // Borders
  border: {
    default: '#30363d',
    subtle: '#21262d',
  }
};

// ============================================
// CONFIGURATION
// ============================================

const SNAPSHOT_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours in ms
const MARKET_REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes for market data
const TOKENS_PER_PAGE = 25;
const TRANSACTIONS_PER_PAGE = 25;
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours cache TTL
const API_DELAY = 250; // Delay between API calls (ms)
const WHALE_CHANGE_THRESHOLD = 10; // % change to trigger alert

// Supported networks
const NETWORKS = {
  eth: { 
    name: 'Ethereum', 
    explorer: 'https://etherscan.io',
    color: '#627eea',
    coingeckoId: 'ethereum',
    geckoTerminalId: 'eth',
    dexScreenerId: 'ethereum'
  },
  arbitrum: { 
    name: 'Arbitrum', 
    explorer: 'https://arbiscan.io',
    color: '#28a0f0',
    coingeckoId: 'arbitrum-one',
    geckoTerminalId: 'arbitrum',
    dexScreenerId: 'arbitrum'
  },
  base: { 
    name: 'Base', 
    explorer: 'https://basescan.org',
    color: '#0052ff',
    coingeckoId: 'base',
    geckoTerminalId: 'base',
    dexScreenerId: 'base'
  },
  polygon: { 
    name: 'Polygon', 
    explorer: 'https://polygonscan.com',
    color: '#8247e5',
    coingeckoId: 'polygon-pos',
    geckoTerminalId: 'polygon_pos',
    dexScreenerId: 'polygon'
  },
  bsc: { 
    name: 'BNB Chain', 
    explorer: 'https://bscscan.com',
    color: '#f0b90b',
    coingeckoId: 'binance-smart-chain',
    geckoTerminalId: 'bsc',
    dexScreenerId: 'bsc'
  },
  solana: {
    name: 'Solana',
    explorer: 'https://solscan.io',
    color: '#9945ff',
    coingeckoId: 'solana',
    geckoTerminalId: 'solana',
    dexScreenerId: 'solana'
  }
};

// Map CoinGecko asset platform IDs to our network keys
const COINGECKO_PLATFORM_MAP = {
  'ethereum': 'eth',
  'arbitrum-one': 'arbitrum',
  'base': 'base',
  'polygon-pos': 'polygon',
  'binance-smart-chain': 'bsc',
  'solana': 'solana'
};

// ============================================
// CACHE MANAGER
// ============================================

const CacheManager = {
  get: (key) => {
    try {
      const cached = localStorage.getItem(`cache_${key}`);
      if (!cached) return null;
      
      const { data, timestamp, ttl } = JSON.parse(cached);
      if (Date.now() - timestamp > ttl) {
        localStorage.removeItem(`cache_${key}`);
        return null;
      }
      return data;
    } catch {
      return null;
    }
  },
  
  set: (key, data, ttl = CACHE_TTL) => {
    try {
      localStorage.setItem(`cache_${key}`, JSON.stringify({
        data,
        timestamp: Date.now(),
        ttl
      }));
    } catch (e) {
      console.warn('Cache storage full, clearing old entries');
      CacheManager.clearOld();
    }
  },
  
  clearOld: () => {
    const keys = Object.keys(localStorage).filter(k => k.startsWith('cache_'));
    keys.forEach(key => {
      try {
        const { timestamp, ttl } = JSON.parse(localStorage.getItem(key) || '{}');
        if (!timestamp || Date.now() - timestamp > ttl) {
          localStorage.removeItem(key);
        }
      } catch {
        localStorage.removeItem(key);
      }
    });
  }
};

// ============================================
// SNAPSHOT MANAGER
// ============================================

const SnapshotManager = {
  getKey: (tokenAddress, chain) => `snapshot_${chain}_${tokenAddress}`,
  
  save: (tokenAddress, chain, holders) => {
    const key = SnapshotManager.getKey(tokenAddress, chain);
    const existing = SnapshotManager.getAll(tokenAddress, chain);
    
    const newSnapshot = {
      timestamp: Date.now(),
      holders: holders.map(h => ({
        address: h.owner_address,
        balance: parseFloat(h.balance_formatted || h.balance) || 0,
        percentage: parseFloat(h.percentage_relative_to_total_supply) || 0
      }))
    };
    
    // Keep last 5 snapshots
    const snapshots = [...existing, newSnapshot].slice(-5);
    
    try {
      localStorage.setItem(key, JSON.stringify(snapshots));
    } catch {
      localStorage.setItem(key, JSON.stringify([newSnapshot]));
    }
    
    return snapshots;
  },
  
  getAll: (tokenAddress, chain) => {
    const key = SnapshotManager.getKey(tokenAddress, chain);
    try {
      return JSON.parse(localStorage.getItem(key) || '[]');
    } catch {
      return [];
    }
  },
  
  getLatest: (tokenAddress, chain) => {
    const snapshots = SnapshotManager.getAll(tokenAddress, chain);
    return snapshots[snapshots.length - 1] || null;
  },
  
  getPrevious: (tokenAddress, chain) => {
    const snapshots = SnapshotManager.getAll(tokenAddress, chain);
    return snapshots[snapshots.length - 2] || null;
  },
  
  compareSnapshots: (current, previous) => {
    if (!previous || !current) return { newWhales: [], exitedWhales: [], changes: {} };
    
    const prevMap = new Map(previous.holders.map(h => [h.address, h]));
    const currMap = new Map(current.holders.map(h => [h.address, h]));
    
    const newWhales = [];
    const exitedWhales = [];
    const changes = {};
    
    current.holders.forEach(holder => {
      const prev = prevMap.get(holder.address);
      if (!prev) {
        newWhales.push(holder.address);
      } else {
        const change = prev.balance > 0 
          ? ((holder.balance - prev.balance) / prev.balance) * 100 
          : 0;
        if (Math.abs(change) > 0.01) {
          changes[holder.address] = {
            previousBalance: prev.balance,
            currentBalance: holder.balance,
            changePercent: change
          };
        }
      }
    });
    
    previous.holders.forEach(holder => {
      if (!currMap.has(holder.address)) {
        exitedWhales.push(holder.address);
      }
    });
    
    return { newWhales, exitedWhales, changes };
  }
};

// ============================================
// API REQUEST QUEUE
// ============================================

class RequestQueue {
  constructor(delay = API_DELAY) {
    this.queue = [];
    this.processing = false;
    this.delay = delay;
  }
  
  async add(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.process();
    });
  }
  
  async process() {
    if (this.processing || this.queue.length === 0) return;
    
    this.processing = true;
    
    while (this.queue.length > 0) {
      const { fn, resolve, reject } = this.queue.shift();
      try {
        const result = await fn();
        resolve(result);
      } catch (error) {
        reject(error);
      }
      
      if (this.queue.length > 0) {
        await new Promise(r => setTimeout(r, this.delay));
      }
    }
    
    this.processing = false;
  }
}

const apiQueue = new RequestQueue();

// ============================================
// UTILITY FUNCTIONS
// ============================================

const formatNumber = (num, decimals = 2) => {
  const parsed = parseFloat(num);
  if (num === null || num === undefined || isNaN(parsed)) return '0';
  if (parsed >= 1e9) return (parsed / 1e9).toFixed(decimals) + 'B';
  if (parsed >= 1e6) return (parsed / 1e6).toFixed(decimals) + 'M';
  if (parsed >= 1e3) return (parsed / 1e3).toFixed(decimals) + 'K';
  return parsed.toFixed(decimals);
};

const formatUSD = (num) => '$' + formatNumber(num);

const formatPercent = (num) => {
  const parsed = parseFloat(num);
  if (num === null || num === undefined || isNaN(parsed)) return '0%';
  const sign = parsed >= 0 ? '+' : '';
  return sign + parsed.toFixed(2) + '%';
};

const shortenAddress = (addr) => {
  if (!addr) return '';
  return addr.slice(0, 6) + '...' + addr.slice(-4);
};

const formatTimeRemaining = (ms) => {
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((ms % (1000 * 60)) / 1000);
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
};

const formatTimeAgo = (timestamp) => {
  const seconds = Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
};

const isWithinDays = (timestamp, days) => {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now - date;
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return diffDays <= days;
};

// ============================================
// COPY BUTTON COMPONENT
// ============================================

const CopyButton = ({ text, style = {} }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  return (
    <button
      onClick={handleCopy}
      style={{
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        padding: '4px',
        borderRadius: '4px',
        color: copied ? '#10b981' : '#666',
        fontSize: '0.75rem',
        transition: 'all 0.2s ease',
        ...style
      }}
      title={copied ? 'Copied!' : 'Copy to clipboard'}
    >
      {copied ? '✓' : '📋'}
    </button>
  );
};

// ============================================
// ADDRESS DISPLAY COMPONENT
// ============================================

const AddressDisplay = ({ address, chain, label, color = '#00d4ff', badges = [], clickable = true, onClick }) => {
  const network = NETWORKS[chain] || NETWORKS.eth;
  const addressPath = chain === 'solana' ? '/account/' : '/address/';
  
  const handleClick = (e) => {
    if (onClick) {
      e.preventDefault();
      e.stopPropagation();
      onClick(address);
    }
  };
  
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
      {onClick ? (
        <span
          onClick={handleClick}
          style={{ 
            fontFamily: 'monospace', 
            color, 
            textDecoration: 'none',
            fontSize: '0.85rem',
            cursor: 'pointer'
          }}
        >
          {shortenAddress(address)}
        </span>
      ) : (
        <a
          href={`${network.explorer}${addressPath}${address}`}
          target="_blank"
          rel="noopener noreferrer"
          style={{ 
            fontFamily: 'monospace', 
            color, 
            textDecoration: 'none',
            fontSize: '0.85rem'
          }}
        >
          {shortenAddress(address)}
        </a>
      )}
      <CopyButton text={address} />
      {label && (
        <span style={{
          background: 'rgba(123, 47, 247, 0.2)',
          color: '#a855f7',
          padding: '2px 6px',
          borderRadius: '4px',
          fontSize: '0.65rem',
          fontWeight: '600'
        }}>
          {label}
        </span>
      )}
      {badges.map((badge, idx) => (
        <span key={idx} style={{
          background: badge.bg || 'rgba(16, 185, 129, 0.2)',
          color: badge.color || '#10b981',
          padding: '2px 6px',
          borderRadius: '4px',
          fontSize: '0.6rem',
          fontWeight: '600'
        }}>
          {badge.text}
        </span>
      ))}
    </span>
  );
};

// ============================================
// NETWORK BADGE COMPONENT
// ============================================

const NetworkBadge = ({ chain, small = false }) => {
  const network = NETWORKS[chain] || NETWORKS.eth;
  return (
    <span style={{
      background: `${network.color}20`,
      color: network.color,
      padding: small ? '2px 6px' : '3px 8px',
      borderRadius: '4px',
      fontSize: small ? '0.6rem' : '0.65rem',
      fontWeight: '600',
      textTransform: 'uppercase'
    }}>
      {network.name}
    </span>
  );
};

// ============================================
// LOADING SPINNER
// ============================================

const LoadingSpinner = ({ size = 20 }) => (
  <div style={{
    width: size,
    height: size,
    border: '2px solid rgba(255,255,255,0.1)',
    borderTopColor: '#7b2ff7',
    borderRadius: '50%',
    animation: 'spin 1s linear infinite'
  }} />
);

// ============================================
// TRANSACTION FILTERS COMPONENT
// ============================================

const TransactionFilters = ({ minAmount, setMinAmount, txType, setTxType }) => (
  <div style={{
    display: 'flex',
    gap: '16px',
    marginBottom: '16px',
    padding: '12px 16px',
    background: 'rgba(255,255,255,0.03)',
    borderRadius: '8px',
    flexWrap: 'wrap',
    alignItems: 'center'
  }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <span style={{ fontSize: '0.75rem', color: '#888' }}>Min USD:</span>
      <select
        value={minAmount}
        onChange={(e) => setMinAmount(Number(e.target.value))}
        style={{
          padding: '6px 10px',
          background: 'rgba(0,0,0,0.3)',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: '6px',
          color: '#fff',
          fontSize: '0.8rem',
          cursor: 'pointer'
        }}
      >
        <option value={0}>Top 100 by Value</option>
        <option value={100}>$100+</option>
        <option value={1000}>$1K+</option>
        <option value={10000}>$10K+</option>
        <option value={50000}>$50K+</option>
        <option value={100000}>$100K+</option>
        <option value={500000}>$500K+</option>
        <option value={1000000}>$1M+</option>
      </select>
    </div>
    
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
      <span style={{ fontSize: '0.75rem', color: '#888' }}>Type:</span>
      {[
        { id: 'all', label: 'All', icon: '📊' },
        { id: 'buy', label: 'Buys', icon: '🟢' },
        { id: 'sell', label: 'Sells', icon: '🔴' },
        { id: 'transfer', label: 'Transfers', icon: '↔️' },
      ].map(type => (
        <button
          key={type.id}
          onClick={() => setTxType(type.id)}
          style={{
            padding: '6px 10px',
            background: txType === type.id 
              ? 'linear-gradient(135deg, #7b2ff7 0%, #f107a3 100%)'
              : 'rgba(255,255,255,0.05)',
            border: 'none',
            borderRadius: '6px',
            color: '#fff',
            fontSize: '0.7rem',
            fontWeight: '600',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '4px'
          }}
        >
          <span>{type.icon}</span> {type.label}
        </button>
      ))}
    </div>
  </div>
);

// ============================================
// PAGINATION COMPONENT
// ============================================

const Pagination = ({ currentPage, totalPages, onPageChange }) => {
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      gap: '8px',
      marginTop: '20px'
    }}>
      <button
        onClick={() => onPageChange(currentPage - 1)}
        disabled={currentPage === 1}
        style={{
          padding: '8px 16px',
          background: currentPage === 1 ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.1)',
          border: 'none',
          borderRadius: '8px',
          color: currentPage === 1 ? '#666' : '#fff',
          cursor: currentPage === 1 ? 'not-allowed' : 'pointer',
          fontWeight: '600'
        }}
      >
        ← Prev
      </button>
      
      {[1, 2, 3, 4].map(page => (
        <button
          key={page}
          onClick={() => onPageChange(page)}
          style={{
            padding: '8px 14px',
            background: currentPage === page 
              ? 'linear-gradient(135deg, #7b2ff7 0%, #f107a3 100%)'
              : 'rgba(255,255,255,0.05)',
            border: 'none',
            borderRadius: '8px',
            color: '#fff',
            cursor: 'pointer',
            fontWeight: '600'
          }}
        >
          {page}
        </button>
      ))}
      
      <button
        onClick={() => onPageChange(currentPage + 1)}
        disabled={currentPage === totalPages}
        style={{
          padding: '8px 16px',
          background: currentPage === totalPages ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.1)',
          border: 'none',
          borderRadius: '8px',
          color: currentPage === totalPages ? '#666' : '#fff',
          cursor: currentPage === totalPages ? 'not-allowed' : 'pointer',
          fontWeight: '600'
        }}
      >
        Next →
      </button>
    </div>
  );
};

// ============================================
// PHASE 4: PRICE CHART COMPONENT
// ============================================

const PriceChart = ({ data, timeframe, setTimeframe }) => {
  if (!data || data.length === 0) {
    return (
      <div style={{
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: '16px',
        padding: '24px',
        textAlign: 'center',
        color: '#888'
      }}>
        No price data available
      </div>
    );
  }

  const prices = data.map(d => d.price);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const priceRange = maxPrice - minPrice || 1;
  const currentPrice = prices[prices.length - 1];
  const startPrice = prices[0];
  const priceChange = ((currentPrice - startPrice) / startPrice * 100);
  const isPositive = priceChange >= 0;

  const step = Math.max(1, Math.floor(data.length / 30));
  const chartData = data.filter((_, i) => i % step === 0 || i === data.length - 1);

  return (
    <div style={{
      background: 'rgba(255,255,255,0.02)',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: '16px',
      padding: '20px',
      marginBottom: '24px'
    }}>
      <div style={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'center',
        marginBottom: '16px',
        flexWrap: 'wrap',
        gap: '12px'
      }}>
        <div>
          <h3 style={{ margin: 0, fontSize: '1rem', color: '#fff' }}>Price Chart</h3>
          <div style={{ fontSize: '1.5rem', fontWeight: '700', color: '#fff', marginTop: '4px' }}>
            ${currentPrice < 0.01 ? currentPrice.toFixed(8) : currentPrice.toFixed(2)}
            <span style={{ fontSize: '0.9rem', marginLeft: '8px', color: isPositive ? '#10b981' : '#ef4444' }}>
              {isPositive ? '↑' : '↓'} {Math.abs(priceChange).toFixed(2)}%
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          {['7', '30', '90'].map(days => (
            <button
              key={days}
              onClick={() => setTimeframe(days)}
              style={{
                padding: '6px 12px',
                background: timeframe === days ? 'linear-gradient(135deg, #7b2ff7 0%, #f107a3 100%)' : 'rgba(255,255,255,0.05)',
                border: 'none',
                borderRadius: '6px',
                color: '#fff',
                fontSize: '0.75rem',
                fontWeight: '600',
                cursor: 'pointer'
              }}
            >
              {days}D
            </button>
          ))}
        </div>
      </div>
      
      <div style={{ height: '150px', position: 'relative' }}>
        <svg width="100%" height="100%" viewBox="0 0 400 150" preserveAspectRatio="none">
          <defs>
            <linearGradient id="chartGradient" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor={isPositive ? '#10b981' : '#ef4444'} stopOpacity="0.3" />
              <stop offset="100%" stopColor={isPositive ? '#10b981' : '#ef4444'} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path
            d={`M 0 ${150 - ((chartData[0]?.price - minPrice) / priceRange) * 140} ` +
              chartData.map((d, i) => `L ${(i / (chartData.length - 1)) * 400} ${150 - ((d.price - minPrice) / priceRange) * 140}`).join(' ') +
              ` L 400 150 L 0 150 Z`}
            fill="url(#chartGradient)"
          />
          <path
            d={`M 0 ${150 - ((chartData[0]?.price - minPrice) / priceRange) * 140} ` +
              chartData.map((d, i) => `L ${(i / (chartData.length - 1)) * 400} ${150 - ((d.price - minPrice) / priceRange) * 140}`).join(' ')}
            fill="none"
            stroke={isPositive ? '#10b981' : '#ef4444'}
            strokeWidth="2"
          />
        </svg>
        <div style={{ position: 'absolute', right: 0, top: 0, fontSize: '0.65rem', color: '#666' }}>
          ${maxPrice < 0.01 ? maxPrice.toFixed(6) : maxPrice.toFixed(2)}
        </div>
        <div style={{ position: 'absolute', right: 0, bottom: 0, fontSize: '0.65rem', color: '#666' }}>
          ${minPrice < 0.01 ? minPrice.toFixed(6) : minPrice.toFixed(2)}
        </div>
      </div>
    </div>
  );
};

// ============================================
// PHASE 4: TOKEN METRICS CARD
// ============================================

const TokenMetricsCard = ({ tokenInfo, holders, poolsData }) => {
  const formatLargeNumber = (num) => {
    if (!num) return '-';
    if (num >= 1e12) return `$${(num / 1e12).toFixed(2)}T`;
    if (num >= 1e9) return `$${(num / 1e9).toFixed(2)}B`;
    if (num >= 1e6) return `$${(num / 1e6).toFixed(2)}M`;
    if (num >= 1e3) return `$${(num / 1e3).toFixed(2)}K`;
    return `$${num.toFixed(2)}`;
  };

  const formatSupply = (num) => {
    if (!num) return '-';
    if (num >= 1e12) return `${(num / 1e12).toFixed(2)}T`;
    if (num >= 1e9) return `${(num / 1e9).toFixed(2)}B`;
    if (num >= 1e6) return `${(num / 1e6).toFixed(2)}M`;
    return num.toLocaleString();
  };

  // Calculate aggregated liquidity from pools data
  const totalLiquidity = poolsData?.reduce((sum, p) => sum + (p.liquidity_usd || 0), 0) || 0;
  const chainsWithPools = poolsData?.chainsFetched?.length || 1;
  const isMultiChain = poolsData?.isMultiChain || (holders?.isMultiChain);

  const metrics = [
    { label: 'Market Cap', value: formatLargeNumber(tokenInfo?.market_cap) },
    { label: 'FDV', value: formatLargeNumber(tokenInfo?.fully_diluted_valuation) },
    { label: '24h Volume', value: formatLargeNumber(tokenInfo?.total_volume) },
    { label: 'DEX Liquidity', value: formatLargeNumber(totalLiquidity), highlight: true },
    { label: 'Circulating', value: formatSupply(tokenInfo?.circulating_supply) },
    { label: 'Holders', value: holders?.length ? `${holders.length}+` : '-' },
  ];

  return (
    <div style={{ marginBottom: '24px' }}>
      {/* Multi-chain indicator */}
      {isMultiChain && (
        <div style={{ 
          display: 'flex', 
          alignItems: 'center', 
          gap: '8px', 
          marginBottom: '12px',
          padding: '10px 14px',
          background: THEME.bg.tertiary,
          border: `1px solid ${THEME.border.default}`,
          borderRadius: '6px'
        }}>
          <span style={{ fontSize: '0.8rem', color: THEME.text.secondary }}>
            Multi-chain token — Data from {chainsWithPools} networks
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '6px' }}>
            {poolsData?.chainsFetched?.map(chain => (
              <span key={chain} style={{
                background: THEME.bg.secondary,
                color: THEME.text.secondary,
                padding: '2px 8px',
                borderRadius: '4px',
                fontSize: '0.7rem',
                fontWeight: '500',
                border: `1px solid ${THEME.border.default}`
              }}>
                {NETWORKS[chain]?.name || chain}
              </span>
            ))}
          </div>
        </div>
      )}
      
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '12px' }}>
        {metrics.map(({ label, value, highlight }) => (
          <div key={label} style={{ 
            background: THEME.bg.secondary, 
            border: `1px solid ${highlight ? THEME.accent.primary + '40' : THEME.border.default}`, 
            borderRadius: '8px', 
            padding: '14px' 
          }}>
            <div style={{ fontSize: '0.7rem', color: THEME.text.muted, marginBottom: '4px' }}>{label}</div>
            <div style={{ fontSize: '1rem', fontWeight: '600', color: highlight ? THEME.accent.primary : THEME.text.primary }}>{value}</div>
          </div>
        ))}
      </div>
    </div>
  );
};

// ============================================
// PHASE 4: HOLDER DISTRIBUTION CHART
// ============================================

const HolderDistributionChart = ({ holders, tokenInfo }) => {
  if (!holders || holders.length === 0) return null;

  // Check if multi-chain data
  const isMultiChain = holders.isMultiChain;
  const chainsFetched = holders.chainsFetched || [];

  // Calculate percentages from the holder data we have
  const rawTop10Total = holders.slice(0, 10).reduce((sum, h) => sum + parseFloat(h.percentage_relative_to_total_supply || 0), 0);
  const rawTop25Total = holders.slice(0, 25).reduce((sum, h) => sum + parseFloat(h.percentage_relative_to_total_supply || 0), 0);
  const rawTop50Total = holders.slice(0, 50).reduce((sum, h) => sum + parseFloat(h.percentage_relative_to_total_supply || 0), 0);
  const rawTop100Total = holders.slice(0, 100).reduce((sum, h) => sum + parseFloat(h.percentage_relative_to_total_supply || 0), 0);
  
  // If total exceeds 100%, normalize
  const normalizationFactor = rawTop100Total > 100 ? 100 / rawTop100Total : 1;
  const top10Total = Math.min(rawTop10Total * normalizationFactor, 100);
  const top25Total = Math.min(rawTop25Total * normalizationFactor, 100);
  const top50Total = Math.min(rawTop50Total * normalizationFactor, 100);
  const top100Total = Math.min(rawTop100Total * normalizationFactor, 100);
  const othersPercent = Math.max(0, 100 - top100Total);

  const segments = [
    { label: 'Top 10', percent: top10Total, color: THEME.accent.primary },
    { label: 'Top 11-25', percent: Math.max(0, top25Total - top10Total), color: '#58a6ff' },
    { label: 'Top 26-50', percent: Math.max(0, top50Total - top25Total), color: '#3fb950' },
    { label: 'Top 51-100', percent: Math.max(0, top100Total - top50Total), color: '#d29922' },
    { label: 'Others', percent: othersPercent, color: THEME.bg.tertiary }
  ].filter(s => s.percent > 0.1);

  let cumulative = 0;
  const circumference = 2 * Math.PI * 70;

  // Concentration analysis
  const isHighlyConcentrated = top10Total > 50;
  const concentrationLabel = top10Total > 70 ? 'Very High' : top10Total > 50 ? 'High' : top10Total > 30 ? 'Moderate' : 'Low';
  const concentrationColor = top10Total > 70 ? THEME.accent.error : top10Total > 50 ? THEME.accent.warning : top10Total > 30 ? '#d29922' : THEME.accent.success;

  return (
    <div style={{ 
      background: THEME.bg.secondary, 
      border: `1px solid ${THEME.border.default}`, 
      borderRadius: '8px', 
      padding: '20px', 
      marginBottom: '20px' 
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <h3 style={{ margin: 0, fontSize: '0.9375rem', fontWeight: '600', color: THEME.text.primary }}>Holder Distribution</h3>
          {isMultiChain && (
            <span style={{ 
              fontSize: '0.7rem', 
              background: THEME.bg.tertiary,
              border: `1px solid ${THEME.border.default}`,
              padding: '2px 8px', 
              borderRadius: '4px',
              color: THEME.text.secondary
            }}>
              {chainsFetched.length} chains
            </span>
          )}
        </div>
        <div style={{
          background: THEME.bg.tertiary,
          border: `1px solid ${THEME.border.default}`,
          color: concentrationColor,
          padding: '4px 10px',
          borderRadius: '4px',
          fontSize: '0.75rem',
          fontWeight: '500'
        }}>
          {concentrationLabel}
        </div>
      </div>
      
      <div style={{ display: 'flex', alignItems: 'center', gap: '32px', flexWrap: 'wrap', justifyContent: 'center' }}>
        {/* Donut Chart */}
        <div style={{ position: 'relative', width: '160px', height: '160px' }}>
          <svg width="160" height="160" viewBox="0 0 160 160">
            {segments.map((segment, i) => {
              const dashArray = (segment.percent / 100) * circumference;
              const dashOffset = -cumulative * circumference / 100;
              cumulative += segment.percent;
              return (
                <circle 
                  key={i} 
                  cx="80" 
                  cy="80" 
                  r="70" 
                  fill="none" 
                  stroke={segment.color} 
                  strokeWidth="16" 
                  strokeDasharray={`${dashArray} ${circumference}`} 
                  strokeDashoffset={dashOffset} 
                  transform="rotate(-90 80 80)" 
                />
              );
            })}
          </svg>
          <div style={{ 
            position: 'absolute', 
            top: '50%', 
            left: '50%', 
            transform: 'translate(-50%, -50%)', 
            textAlign: 'center' 
          }}>
            <div style={{ fontSize: '1.5rem', fontWeight: '600', color: THEME.text.primary }}>{top10Total.toFixed(1)}%</div>
            <div style={{ fontSize: '0.7rem', color: THEME.text.muted }}>Top 10</div>
          </div>
        </div>

        {/* Legend */}
        <div style={{ flex: 1, minWidth: '180px' }}>
          {segments.map((segment, i) => (
            <div key={i} style={{ 
              display: 'flex', 
              alignItems: 'center', 
              gap: '10px', 
              marginBottom: '8px',
              padding: '6px 10px',
              background: THEME.bg.tertiary,
              borderRadius: '4px'
            }}>
              <div style={{ 
                width: '12px', 
                height: '12px', 
                borderRadius: '3px', 
                background: segment.color,
                flexShrink: 0
              }} />
              <span style={{ fontSize: '0.8rem', color: THEME.text.secondary, flex: 1 }}>{segment.label}</span>
              <span style={{ 
                fontSize: '0.8rem', 
                fontWeight: '600', 
                color: THEME.text.primary,
                minWidth: '50px',
                textAlign: 'right'
              }}>
                {segment.percent.toFixed(1)}%
              </span>
            </div>
          ))}
          
          <div style={{ 
            marginTop: '12px', 
            padding: '10px', 
            background: THEME.bg.tertiary, 
            borderRadius: '4px',
            fontSize: '0.75rem',
            color: THEME.text.muted
          }}>
            Based on top {holders.length} holders
            {isHighlyConcentrated && <span style={{ color: THEME.accent.warning }}> • High concentration risk</span>}
          </div>
        </div>
      </div>
    </div>
  );
};

// ============================================
// PHASE 4: LIQUIDITY & ACTIVITY TABLE
// ============================================

const PoolsTable = ({ pools }) => {
  if (!pools || pools.length === 0) return null;
  
  const formatNum = (num) => {
    if (!num) return '-';
    if (num >= 1e9) return `$${(num / 1e9).toFixed(2)}B`;
    if (num >= 1e6) return `$${(num / 1e6).toFixed(2)}M`;
    if (num >= 1e3) return `$${(num / 1e3).toFixed(2)}K`;
    return `$${num.toFixed(2)}`;
  };

  const totalLiquidity = pools.reduce((sum, p) => sum + (p.liquidity_usd || 0), 0);
  const totalVolume = pools.reduce((sum, p) => sum + (p.volume_24h || 0), 0);
  const totalBuys = pools.reduce((sum, p) => sum + (p.buys_24h || 0), 0);
  const totalSells = pools.reduce((sum, p) => sum + (p.sells_24h || 0), 0);
  const totalTxs = totalBuys + totalSells;
  const buyVolume = totalTxs > 0 ? (totalVolume * totalBuys / totalTxs) : 0;
  const sellVolume = totalTxs > 0 ? (totalVolume * totalSells / totalTxs) : 0;

  return (
    <div style={{ background: THEME.bg.secondary, border: `1px solid ${THEME.border.default}`, borderRadius: '8px', padding: '20px', marginBottom: '20px' }}>
      <h3 style={{ margin: '0 0 16px 0', fontSize: '0.9375rem', fontWeight: '600', color: THEME.text.primary }}>Liquidity & Activity</h3>
      
      {/* Summary Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px', marginBottom: '16px' }}>
        <div style={{ background: THEME.bg.tertiary, borderRadius: '6px', padding: '12px', textAlign: 'center' }}>
          <div style={{ fontSize: '0.7rem', color: THEME.text.muted, marginBottom: '4px' }}>Liquidity</div>
          <div style={{ fontSize: '1rem', fontWeight: '600', color: THEME.text.primary }}>{formatNum(totalLiquidity)}</div>
        </div>
        <div style={{ background: THEME.bg.tertiary, borderRadius: '6px', padding: '12px', textAlign: 'center' }}>
          <div style={{ fontSize: '0.7rem', color: THEME.text.muted, marginBottom: '4px' }}>24h Volume</div>
          <div style={{ fontSize: '1rem', fontWeight: '600', color: THEME.text.primary }}>{formatNum(totalVolume)}</div>
        </div>
        <div style={{ background: THEME.bg.tertiary, borderRadius: '6px', padding: '12px', textAlign: 'center' }}>
          <div style={{ fontSize: '0.7rem', color: THEME.accent.success, marginBottom: '4px' }}>Buy Vol</div>
          <div style={{ fontSize: '1rem', fontWeight: '600', color: THEME.accent.success }}>{formatNum(buyVolume)}</div>
          <div style={{ fontSize: '0.65rem', color: THEME.text.muted }}>{totalBuys.toLocaleString()} txns</div>
        </div>
        <div style={{ background: THEME.bg.tertiary, borderRadius: '6px', padding: '12px', textAlign: 'center' }}>
          <div style={{ fontSize: '0.7rem', color: THEME.accent.error, marginBottom: '4px' }}>Sell Vol</div>
          <div style={{ fontSize: '1rem', fontWeight: '600', color: THEME.accent.error }}>{formatNum(sellVolume)}</div>
          <div style={{ fontSize: '0.65rem', color: THEME.text.muted }}>{totalSells.toLocaleString()} txns</div>
        </div>
      </div>

      {/* Buy/Sell Ratio Bar */}
      <div style={{ marginBottom: '16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px', fontSize: '0.7rem', color: THEME.text.muted }}>
          <span>Buys</span>
          <span>Sells</span>
        </div>
        <div style={{ display: 'flex', height: '6px', borderRadius: '3px', overflow: 'hidden', background: THEME.bg.tertiary }}>
          <div style={{ 
            width: `${totalTxs > 0 ? (totalBuys / totalTxs * 100) : 50}%`, 
            background: THEME.accent.success,
            transition: 'width 0.3s'
          }} />
          <div style={{ 
            width: `${totalTxs > 0 ? (totalSells / totalTxs * 100) : 50}%`, 
            background: THEME.accent.error,
            transition: 'width 0.3s'
          }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px', fontSize: '0.7rem' }}>
          <span style={{ color: THEME.accent.success }}>{totalTxs > 0 ? (totalBuys / totalTxs * 100).toFixed(1) : 50}%</span>
          <span style={{ color: THEME.accent.error }}>{totalTxs > 0 ? (totalSells / totalTxs * 100).toFixed(1) : 50}%</span>
        </div>
      </div>

      {/* Pools Table */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${THEME.border.default}` }}>
              <th style={{ padding: '10px', textAlign: 'left', color: THEME.text.muted, fontWeight: '500' }}>Pool</th>
              <th style={{ padding: '10px', textAlign: 'right', color: THEME.text.muted, fontWeight: '500' }}>Liquidity</th>
              <th style={{ padding: '10px', textAlign: 'right', color: THEME.text.muted, fontWeight: '500' }}>24h Vol</th>
              <th style={{ padding: '10px', textAlign: 'right', color: THEME.text.muted, fontWeight: '500' }}>Buys</th>
              <th style={{ padding: '10px', textAlign: 'right', color: THEME.text.muted, fontWeight: '500' }}>Sells</th>
            </tr>
          </thead>
          <tbody>
            {pools.slice(0, 6).map((pool, i) => (
              <tr key={i} style={{ borderBottom: `1px solid ${THEME.border.subtle}` }}>
                <td style={{ padding: '10px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {pool.chain && (
                      <span style={{
                        background: THEME.bg.tertiary,
                        color: THEME.text.secondary,
                        padding: '2px 6px',
                        borderRadius: '3px',
                        fontSize: '0.65rem',
                        fontWeight: '500'
                      }}>
                        {NETWORKS[pool.chain]?.name?.slice(0, 3) || pool.chain}
                      </span>
                    )}
                    <div>
                      <div style={{ fontWeight: '500', color: THEME.text.primary }}>{pool.name || 'Unknown'}</div>
                      <div style={{ fontSize: '0.7rem', color: THEME.text.muted }}>{pool.dex}</div>
                    </div>
                  </div>
                </td>
                <td style={{ padding: '10px', textAlign: 'right', color: THEME.text.primary }}>{formatNum(pool.liquidity_usd)}</td>
                <td style={{ padding: '10px', textAlign: 'right', color: THEME.text.primary }}>{formatNum(pool.volume_24h)}</td>
                <td style={{ padding: '10px', textAlign: 'right', color: THEME.accent.success, fontWeight: '500' }}>{(pool.buys_24h || 0).toLocaleString()}</td>
                <td style={{ padding: '10px', textAlign: 'right', color: THEME.accent.error, fontWeight: '500' }}>{(pool.sells_24h || 0).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ============================================
// PHASE 4: SOCIAL LINKS
// ============================================

const SocialLinks = ({ links }) => {
  if (!links) return null;
  const items = [
    { key: 'homepage', label: 'Website' },
    { key: 'twitter', label: 'Twitter' },
    { key: 'telegram', label: 'Telegram' },
    { key: 'discord', label: 'Discord' },
    { key: 'github', label: 'GitHub' }
  ].filter(item => links[item.key]);
  if (items.length === 0) return null;

  return (
    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '16px' }}>
      {items.map(({ key, label }) => (
        <a key={key} href={links[key]} target="_blank" rel="noopener noreferrer"
          style={{ padding: '6px 12px', background: THEME.bg.tertiary, border: `1px solid ${THEME.border.default}`, borderRadius: '4px', color: THEME.text.secondary, textDecoration: 'none', fontSize: '0.75rem', transition: 'all 0.15s' }}>
          {label}
        </a>
      ))}
    </div>
  );
};

// ============================================
// PHASE 4: WALLET PROFILER MODAL
// ============================================

const WalletProfiler = ({ wallet, walletData, loading, onClose, chain }) => {
  if (!wallet) return null;
  const network = NETWORKS[chain] || NETWORKS.eth;
  const formatUSD = (v) => {
    if (!v) return '$0';
    if (v >= 1e9) return `$${(v/1e9).toFixed(2)}B`;
    if (v >= 1e6) return `$${(v/1e6).toFixed(2)}M`;
    if (v >= 1e3) return `$${(v/1e3).toFixed(2)}K`;
    return `$${v.toFixed(2)}`;
  };
  const topHoldings = walletData?.portfolio?.slice(0, 15) || [];
  const totalValue = walletData?.total_value || 0;
  const chainBreakdown = walletData?.chain_breakdown || [];
  const isMultiChain = walletData?.multiChain;

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000, padding: '20px' }}>
      <div style={{ background: THEME.bg.secondary, border: `1px solid ${THEME.border.default}`, borderRadius: '12px', width: '100%', maxWidth: '700px', maxHeight: '85vh', overflow: 'auto' }}>
        <div style={{ padding: '16px 20px', borderBottom: `1px solid ${THEME.border.default}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', position: 'sticky', top: 0, background: THEME.bg.secondary, zIndex: 1 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: '600', color: THEME.text.primary, display: 'flex', alignItems: 'center', gap: '8px' }}>
              Wallet Profile
              {isMultiChain && <span style={{ fontSize: '0.7rem', background: THEME.bg.tertiary, border: `1px solid ${THEME.border.default}`, padding: '2px 8px', borderRadius: '4px', color: THEME.text.secondary }}>Multi-Chain</span>}
            </h2>
            <a href={`${network.explorer}/address/${wallet}`} target="_blank" rel="noopener noreferrer" style={{ color: THEME.accent.secondary, fontSize: '0.75rem', textDecoration: 'none' }}>
              {wallet.slice(0, 10)}...{wallet.slice(-8)} ↗
            </a>
          </div>
          <button onClick={onClose} style={{ background: THEME.bg.tertiary, border: `1px solid ${THEME.border.default}`, borderRadius: '6px', color: THEME.text.secondary, padding: '6px 12px', cursor: 'pointer', fontSize: '0.875rem' }}>Close</button>
        </div>
        <div style={{ padding: '20px' }}>
          {loading ? (
            <div style={{ textAlign: 'center', padding: '40px', color: THEME.text.secondary }}><LoadingSpinner size={24} /><div style={{ marginTop: '12px' }}>Loading...</div></div>
          ) : walletData ? (
            <>
              {/* Summary Stats */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', marginBottom: '20px' }}>
                <div style={{ background: THEME.bg.tertiary, borderRadius: '8px', padding: '14px', textAlign: 'center' }}>
                  <div style={{ fontSize: '0.7rem', color: THEME.text.muted }}>Total Value</div>
                  <div style={{ fontSize: '1.25rem', fontWeight: '600', color: THEME.accent.success }}>{formatUSD(totalValue)}</div>
                </div>
                <div style={{ background: THEME.bg.tertiary, borderRadius: '8px', padding: '14px', textAlign: 'center' }}>
                  <div style={{ fontSize: '0.7rem', color: THEME.text.muted }}>Tokens</div>
                  <div style={{ fontSize: '1.25rem', fontWeight: '600', color: THEME.text.primary }}>{walletData.token_count || 0}</div>
                </div>
                <div style={{ background: THEME.bg.tertiary, borderRadius: '8px', padding: '14px', textAlign: 'center' }}>
                  <div style={{ fontSize: '0.7rem', color: THEME.text.muted }}>Chains</div>
                  <div style={{ fontSize: '1.25rem', fontWeight: '600', color: THEME.text.primary }}>{chainBreakdown.length || 1}</div>
                </div>
              </div>

              {/* Chain Breakdown */}
              {isMultiChain && chainBreakdown.length > 0 && (
                <div style={{ marginBottom: '20px' }}>
                  <h3 style={{ margin: '0 0 10px 0', fontSize: '0.8125rem', fontWeight: '600', color: THEME.text.primary }}>Value by Chain</h3>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    {chainBreakdown.sort((a, b) => b.value - a.value).map((c, i) => {
                      const pct = totalValue > 0 ? (c.value / totalValue * 100) : 0;
                      return (
                        <div key={i} style={{
                          background: THEME.bg.tertiary,
                          border: `1px solid ${THEME.border.default}`,
                          borderRadius: '6px',
                          padding: '10px 14px',
                          minWidth: '100px'
                        }}>
                          <div style={{ fontSize: '0.7rem', color: THEME.text.secondary }}>{c.name}</div>
                          <div style={{ fontSize: '0.9rem', fontWeight: '600', color: THEME.text.primary }}>{formatUSD(c.value)}</div>
                          <div style={{ fontSize: '0.65rem', color: THEME.text.muted }}>{pct.toFixed(1)}%</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Top Holdings */}
              <h3 style={{ margin: '0 0 10px 0', fontSize: '0.8125rem', fontWeight: '600', color: THEME.text.primary }}>Top Holdings</h3>
              <div style={{ background: THEME.bg.tertiary, borderRadius: '8px', overflow: 'hidden' }}>
                {topHoldings.length > 0 ? (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
                    <thead><tr style={{ borderBottom: `1px solid ${THEME.border.default}` }}>
                      <th style={{ padding: '10px', textAlign: 'left', color: THEME.text.muted, fontWeight: '500' }}>Token</th>
                      {isMultiChain && <th style={{ padding: '10px', textAlign: 'left', color: THEME.text.muted, fontWeight: '500' }}>Chains</th>}
                      <th style={{ padding: '10px', textAlign: 'right', color: THEME.text.muted, fontWeight: '500' }}>Balance</th>
                      <th style={{ padding: '10px', textAlign: 'right', color: THEME.text.muted, fontWeight: '500' }}>Value</th>
                    </tr></thead>
                    <tbody>
                      {topHoldings.map((t, i) => (
                        <tr key={i} style={{ borderBottom: `1px solid ${THEME.border.subtle}` }}>
                          <td style={{ padding: '10px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                              {t.logo && <img src={t.logo} alt="" style={{ width: '20px', height: '20px', borderRadius: '50%' }} onError={e => e.target.style.display='none'} />}
                              <div><div style={{ fontWeight: '500', color: THEME.text.primary }}>{t.symbol}</div><div style={{ fontSize: '0.7rem', color: THEME.text.muted }}>{t.name?.slice(0, 18)}</div></div>
                            </div>
                          </td>
                          {isMultiChain && (
                            <td style={{ padding: '10px' }}>
                              <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                                {(t.chains || []).map((c, ci) => (
                                  <span key={ci} style={{
                                    background: `${NETWORKS[c]?.color || '#666'}30`,
                                    color: NETWORKS[c]?.color || '#888',
                                    padding: '2px 6px',
                                    borderRadius: '4px',
                                    fontSize: '0.6rem',
                                    fontWeight: '600'
                                  }}>
                                    {NETWORKS[c]?.name?.slice(0, 3) || c}
                                  </span>
                                ))}
                              </div>
                            </td>
                          )}
                          <td style={{ padding: '12px', textAlign: 'right', color: '#fff' }}>{t.balance?.toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
                          <td style={{ padding: '12px', textAlign: 'right', color: '#10b981', fontWeight: '600' }}>{formatUSD(t.usd_value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : <div style={{ padding: '20px', textAlign: 'center', color: '#888' }}>No tokens found</div>}
              </div>
            </>
          ) : <div style={{ textAlign: 'center', padding: '40px', color: '#888' }}>Failed to load wallet data</div>}
        </div>
      </div>
    </div>
  );
};

// ============================================
// PHASE 4: WALLET TRACKER VIEW
// ============================================

const WalletTrackerView = ({ onSelectWallet }) => {
  const [walletSearch, setWalletSearch] = useState('');
  const [selectedChain, setSelectedChain] = useState('eth');
  const [trackedWallets, setTrackedWallets] = useState(() => {
    const saved = localStorage.getItem('trackedWallets');
    return saved ? JSON.parse(saved) : [];
  });
  const [topTraders, setTopTraders] = useState([]);
  const [loading, setLoading] = useState(false);

  // Save tracked wallets to localStorage
  useEffect(() => {
    localStorage.setItem('trackedWallets', JSON.stringify(trackedWallets));
  }, [trackedWallets]);

  const handleAddWallet = () => {
    if (!walletSearch) return;
    
    // Validate address format
    const isValid = walletSearch.startsWith('0x') 
      ? walletSearch.length === 42 
      : walletSearch.length >= 32 && walletSearch.length <= 44;
    
    if (!isValid) {
      alert('Invalid wallet address');
      return;
    }

    const chain = walletSearch.startsWith('0x') ? selectedChain : 'solana';
    
    const exists = trackedWallets.some(w => 
      w.address.toLowerCase() === walletSearch.toLowerCase()
    );
    
    if (!exists) {
      setTrackedWallets([...trackedWallets, {
        address: walletSearch,
        chain,
        addedAt: new Date().toISOString(),
        label: ''
      }]);
    }
    setWalletSearch('');
  };

  const handleRemoveWallet = (address) => {
    setTrackedWallets(trackedWallets.filter(w => w.address !== address));
  };

  const formatUSD = (v) => {
    if (!v) return '$0';
    if (v >= 1e9) return `$${(v/1e9).toFixed(2)}B`;
    if (v >= 1e6) return `$${(v/1e6).toFixed(2)}M`;
    if (v >= 1e3) return `$${(v/1e3).toFixed(2)}K`;
    return `$${v.toFixed(2)}`;
  };

  return (
    <div style={{ marginTop: '24px' }}>
      {/* Add Wallet Section */}
      <div style={{
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: '16px',
        padding: '24px',
        marginBottom: '24px'
      }}>
        <h2 style={{ margin: '0 0 16px 0', fontSize: '1.2rem', color: '#fff' }}>
          👛 Track Wallets
        </h2>
        <p style={{ color: '#888', fontSize: '0.85rem', marginBottom: '16px' }}>
          Add wallet addresses to track their holdings and activity across chains.
        </p>
        
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
          <input
            type="text"
            value={walletSearch}
            onChange={(e) => setWalletSearch(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleAddWallet()}
            placeholder="Enter wallet address (0x... or Solana)"
            style={{
              flex: 1,
              minWidth: '300px',
              padding: '12px 16px',
              background: 'rgba(0,0,0,0.3)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '8px',
              color: '#fff',
              fontSize: '0.9rem'
            }}
          />
          <select
            value={selectedChain}
            onChange={(e) => setSelectedChain(e.target.value)}
            style={{
              padding: '12px 16px',
              background: 'rgba(0,0,0,0.3)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '8px',
              color: '#fff',
              fontSize: '0.9rem',
              cursor: 'pointer'
            }}
          >
            {Object.entries(NETWORKS).map(([key, net]) => (
              <option key={key} value={key}>{net.name}</option>
            ))}
          </select>
          <button
            onClick={handleAddWallet}
            style={{
              padding: '12px 24px',
              background: 'linear-gradient(135deg, #7b2ff7 0%, #f107a3 100%)',
              border: 'none',
              borderRadius: '8px',
              color: '#fff',
              fontSize: '0.9rem',
              fontWeight: '600',
              cursor: 'pointer'
            }}
          >
            + Add Wallet
          </button>
        </div>
      </div>

      {/* Tracked Wallets */}
      {trackedWallets.length > 0 && (
        <div style={{
          background: 'rgba(255,255,255,0.02)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: '16px',
          padding: '24px',
          marginBottom: '24px'
        }}>
          <h3 style={{ margin: '0 0 16px 0', fontSize: '1rem', color: '#fff' }}>
            Your Tracked Wallets ({trackedWallets.length})
          </h3>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {trackedWallets.map((wallet, idx) => {
              const network = NETWORKS[wallet.chain] || NETWORKS.eth;
              return (
                <div
                  key={wallet.address}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '12px 16px',
                    background: 'rgba(255,255,255,0.03)',
                    borderRadius: '8px',
                    gap: '12px'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1 }}>
                    <span style={{
                      background: `${network.color}20`,
                      color: network.color,
                      padding: '4px 8px',
                      borderRadius: '6px',
                      fontSize: '0.7rem',
                      fontWeight: '600'
                    }}>
                      {network.name}
                    </span>
                    <span
                      onClick={() => onSelectWallet(wallet.address, wallet.chain)}
                      style={{
                        fontFamily: 'monospace',
                        color: '#00d4ff',
                        cursor: 'pointer',
                        fontSize: '0.85rem'
                      }}
                    >
                      {wallet.address.slice(0, 10)}...{wallet.address.slice(-8)}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <a
                      href={`${network.explorer}/address/${wallet.address}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        padding: '6px 12px',
                        background: 'rgba(255,255,255,0.05)',
                        border: 'none',
                        borderRadius: '6px',
                        color: '#888',
                        fontSize: '0.75rem',
                        textDecoration: 'none'
                      }}
                    >
                      Explorer ↗
                    </a>
                    <button
                      onClick={() => handleRemoveWallet(wallet.address)}
                      style={{
                        padding: '6px 12px',
                        background: 'rgba(239, 68, 68, 0.2)',
                        border: 'none',
                        borderRadius: '6px',
                        color: '#ef4444',
                        fontSize: '0.75rem',
                        cursor: 'pointer'
                      }}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Info Section */}
      <div style={{
        background: 'rgba(123, 47, 247, 0.1)',
        border: '1px solid rgba(123, 47, 247, 0.3)',
        borderRadius: '16px',
        padding: '24px',
        marginBottom: '24px'
      }}>
        <h3 style={{ margin: '0 0 12px 0', fontSize: '1rem', color: '#a855f7' }}>
          🚀 Coming Soon: Top Traders Leaderboard
        </h3>
        <p style={{ color: '#888', fontSize: '0.85rem', margin: 0 }}>
          Track the most profitable traders based on PnL and portfolio performance. 
          This feature requires additional API integration for historical trade data.
        </p>
      </div>

      {/* Empty State */}
      {trackedWallets.length === 0 && (
        <div style={{
          textAlign: 'center',
          padding: '60px 20px',
          color: '#888'
        }}>
          <div style={{ fontSize: '3rem', marginBottom: '16px' }}>👛</div>
          <h3 style={{ color: '#fff', marginBottom: '8px' }}>No Wallets Tracked Yet</h3>
          <p>Add a wallet address above to start tracking holdings and activity.</p>
        </div>
      )}
    </div>
  );
};

// ============================================
// TOKEN ROW COMPONENT (for market overview)
// ============================================

const TokenRow = ({ token, rank, onTrack, isTracked }) => {
  const priceChange = parseFloat(token.price_change_percentage_24h || 0) || 0;
  const isPositive = priceChange >= 0;
  
  // Determine network from platforms data if available
  // CoinGecko markets endpoint aggregates across chains
  let networkKey = null;
  let multiChain = false;
  
  if (token.platforms && Object.keys(token.platforms).length > 0) {
    const supportedPlatforms = Object.entries(token.platforms)
      .filter(([platform, address]) => address && COINGECKO_PLATFORM_MAP[platform]);
    
    if (supportedPlatforms.length > 1) {
      multiChain = true;
    } else if (supportedPlatforms.length === 1) {
      networkKey = COINGECKO_PLATFORM_MAP[supportedPlatforms[0][0]];
    }
  }
  
  // Default to multi-chain since CoinGecko aggregates data
  if (!networkKey && !multiChain) {
    multiChain = true;
  }
  
  return (
    <tr
      style={{
        borderBottom: '1px solid rgba(255,255,255,0.05)',
        transition: 'background 0.2s ease'
      }}
      onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
    >
      {/* Rank */}
      <td style={{ padding: '12px 16px' }}>
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '28px',
          height: '28px',
          background: rank <= 3 
            ? 'linear-gradient(135deg, #ffd700 0%, #ff8c00 100%)'
            : 'rgba(255,255,255,0.1)',
          borderRadius: '6px',
          fontSize: '0.75rem',
          fontWeight: '700',
          color: rank <= 3 ? '#000' : '#888'
        }}>
          {rank}
        </span>
      </td>

      {/* Token */}
      <td style={{ padding: '12px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{
            width: '32px',
            height: '32px',
            borderRadius: '50%',
            background: 'rgba(255,255,255,0.1)',
            overflow: 'hidden',
            flexShrink: 0
          }}>
            {token.image && (
              <img 
                src={token.image} 
                alt={token.symbol} 
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                onError={(e) => { e.target.style.display = 'none'; }}
              />
            )}
          </div>
          <div>
            <div style={{ fontWeight: '600', textTransform: 'uppercase' }}>{token.symbol}</div>
            <div style={{ fontSize: '0.75rem', color: '#888' }}>{token.name}</div>
          </div>
        </div>
      </td>

      {/* Network */}
      <td style={{ padding: '12px 16px' }}>
        {multiChain ? (
          <span style={{
            background: 'rgba(147, 51, 234, 0.2)',
            color: '#a855f7',
            padding: '2px 6px',
            borderRadius: '4px',
            fontSize: '0.6rem',
            fontWeight: '600',
            textTransform: 'uppercase'
          }}>
            Multi-chain
          </span>
        ) : (
          <NetworkBadge chain={networkKey || 'eth'} small />
        )}
      </td>

      {/* Price */}
      <td style={{ padding: '12px 16px', textAlign: 'right' }}>
        <div style={{ fontWeight: '600' }}>{formatUSD(token.current_price || 0)}</div>
      </td>

      {/* 24h Change */}
      <td style={{ padding: '12px 16px', textAlign: 'right' }}>
        <span style={{ 
          color: isPositive ? '#10b981' : '#ef4444',
          fontWeight: '600'
        }}>
          {formatPercent(priceChange)}
        </span>
      </td>

      {/* Market Cap */}
      <td style={{ padding: '12px 16px', textAlign: 'right' }}>
        {formatUSD(token.market_cap || 0)}
      </td>

      {/* 24h Volume */}
      <td style={{ padding: '12px 16px', textAlign: 'right' }}>
        {formatUSD(token.total_volume || 0)}
      </td>

      {/* Action */}
      <td style={{ padding: '12px 16px', textAlign: 'right' }}>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onTrack(token);
          }}
          style={{
            padding: '6px 12px',
            background: isTracked 
              ? 'rgba(16, 185, 129, 0.2)'
              : 'linear-gradient(135deg, #7b2ff7 0%, #f107a3 100%)',
            border: 'none',
            borderRadius: '6px',
            color: isTracked ? '#10b981' : '#fff',
            fontSize: '0.7rem',
            fontWeight: '600',
            cursor: 'pointer'
          }}
        >
          {isTracked ? '✓' : '+'}
        </button>
      </td>
    </tr>
  );
};

// ============================================
// MARKET OVERVIEW SECTION (using CoinGecko)
// ============================================

const MarketOverview = ({ onTrackToken, trackedTokens }) => {
  const [allTokens, setAllTokens] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeMarketTab, setActiveMarketTab] = useState('gainers');
  const [currentPage, setCurrentPage] = useState(1);

  const fetchMarketData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      // Fetch top 250 tokens to have enough for filtering
      const response = await fetch(
        '/api/moralis?source=coingecko&endpoint=' + encodeURIComponent(
          '/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=false&price_change_percentage=24h'
        )
      );
      
      if (response.ok) {
        const data = await response.json();
        setAllTokens(data || []);
      } else if (response.status === 429) {
        console.warn('CoinGecko rate limited, will retry');
        setError('Rate limited by CoinGecko. Data will refresh automatically.');
      } else {
        const errorData = await response.json().catch(() => ({}));
        console.error('Market data response error:', errorData);
        throw new Error(errorData.error || 'Failed to fetch market data');
      }
    } catch (err) {
      console.error('Market data error:', err);
      // Only show error if we don't have any data
      if (allTokens.length === 0) {
        setError('Failed to load market data. CoinGecko API may be rate limited.');
      }
    } finally {
      setLoading(false);
    }
  }, [allTokens.length]);

  useEffect(() => {
    fetchMarketData();
    const interval = setInterval(fetchMarketData, MARKET_REFRESH_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchMarketData]);

  // Reset to page 1 when tab changes
  useEffect(() => {
    setCurrentPage(1);
  }, [activeMarketTab]);

  const isTokenTracked = (token) => {
    return trackedTokens.some(t => 
      t.coingeckoId === token.id || t.symbol?.toLowerCase() === token.symbol?.toLowerCase()
    );
  };

  const handleTrack = async (token) => {
    // Fetch detailed token info to get contract addresses
    try {
      const response = await fetch(
        '/api/moralis?source=coingecko&endpoint=' + encodeURIComponent(`/coins/${token.id}`)
      );
      
      if (response.ok) {
        const data = await response.json();
        
        // Find the first available contract address
        let contractAddress = null;
        let chain = 'eth';
        
        if (data.platforms) {
          for (const [platform, address] of Object.entries(data.platforms)) {
            if (address && COINGECKO_PLATFORM_MAP[platform]) {
              contractAddress = address;
              chain = COINGECKO_PLATFORM_MAP[platform];
              break;
            }
          }
        }
        
        onTrackToken({
          address: contractAddress || token.id,
          symbol: token.symbol?.toUpperCase(),
          name: token.name,
          chain: chain,
          logo: token.image || '🪙',
          coingeckoId: token.id,
          hasContractAddress: !!contractAddress
        });
      } else {
        // Fallback without contract address
        onTrackToken({
          address: token.id,
          symbol: token.symbol?.toUpperCase(),
          name: token.name,
          chain: 'eth',
          logo: token.image || '🪙',
          coingeckoId: token.id,
          hasContractAddress: false
        });
      }
    } catch (err) {
      console.error('Failed to fetch token details:', err);
      // Fallback
      onTrackToken({
        address: token.id,
        symbol: token.symbol?.toUpperCase(),
        name: token.name,
        chain: 'eth',
        logo: token.image || '🪙',
        coingeckoId: token.id,
        hasContractAddress: false
      });
    }
  };

  // Get tokens based on active tab
  const getDisplayTokens = () => {
    const tokens = [...allTokens];
    
    switch (activeMarketTab) {
      case 'gainers':
        return tokens
          .filter(t => (t.price_change_percentage_24h || 0) > 0)
          .sort((a, b) => (b.price_change_percentage_24h || 0) - (a.price_change_percentage_24h || 0))
          .slice(0, 100);
      case 'losers':
        return tokens
          .filter(t => (t.price_change_percentage_24h || 0) < 0)
          .sort((a, b) => (a.price_change_percentage_24h || 0) - (b.price_change_percentage_24h || 0))
          .slice(0, 100);
      case 'volume':
        return tokens
          .sort((a, b) => (b.total_volume || 0) - (a.total_volume || 0))
          .slice(0, 100);
      default:
        return tokens.slice(0, 100);
    }
  };

  const allDisplayTokens = getDisplayTokens();
  const totalPages = Math.ceil(allDisplayTokens.length / TOKENS_PER_PAGE);
  const startIndex = (currentPage - 1) * TOKENS_PER_PAGE;
  const displayTokens = allDisplayTokens.slice(startIndex, startIndex + TOKENS_PER_PAGE);

  return (
    <div style={{ marginBottom: '32px' }}>
      {/* Section Header */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '20px'
      }}>
        <h2 style={{
          fontSize: '1.125rem',
          fontWeight: '600',
          margin: 0,
          color: THEME.text.primary
        }}>
          Market Overview
        </h2>
        <div style={{ fontSize: '0.75rem', color: THEME.text.muted }}>
          Data from CoinGecko • Top 100 tokens • Auto-refresh
        </div>
      </div>

      {/* Market Tabs */}
      <div style={{
        display: 'flex',
        gap: '4px',
        marginBottom: '16px',
        borderBottom: `1px solid ${THEME.border.default}`,
        paddingBottom: '12px'
      }}>
        {[
          { id: 'gainers', label: 'Top Gainers' },
          { id: 'losers', label: 'Top Losers' },
          { id: 'volume', label: 'Top Volume' }
        ].map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveMarketTab(tab.id)}
            style={{
              padding: '8px 16px',
              background: activeMarketTab === tab.id ? THEME.bg.tertiary : 'transparent',
              border: 'none',
              borderRadius: '6px',
              color: activeMarketTab === tab.id ? THEME.text.primary : THEME.text.secondary,
              fontSize: '0.8125rem',
              fontWeight: '500',
              cursor: 'pointer',
              transition: 'all 0.15s ease'
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      {loading ? (
        <div style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          padding: '60px',
          background: THEME.bg.secondary,
          borderRadius: '8px',
          border: `1px solid ${THEME.border.default}`
        }}>
          <LoadingSpinner size={24} />
          <span style={{ marginLeft: '12px', color: THEME.text.secondary }}>Loading market data...</span>
        </div>
      ) : error ? (
        <div style={{
          padding: '40px',
          textAlign: 'center',
          background: THEME.bg.secondary,
          borderRadius: '8px',
          border: `1px solid ${THEME.border.default}`,
          color: THEME.accent.error
        }}>
          {error}
          <button
            onClick={fetchMarketData}
            style={{
              display: 'block',
              margin: '16px auto 0',
              padding: '8px 16px',
              background: THEME.bg.tertiary,
              border: `1px solid ${THEME.border.default}`,
              borderRadius: '6px',
              color: THEME.text.primary,
              cursor: 'pointer'
            }}
          >
            Retry
          </button>
        </div>
      ) : (
        <>
          {/* Table */}
          <div style={{
            background: THEME.bg.secondary,
            border: `1px solid ${THEME.border.default}`,
            borderRadius: '8px',
            overflow: 'hidden'
          }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                <thead>
                  <tr style={{ 
                    background: 'rgba(255,255,255,0.05)',
                    borderBottom: '1px solid rgba(255,255,255,0.1)'
                  }}>
                    <th style={{ padding: '14px 16px', textAlign: 'left', color: '#888', fontWeight: '600', fontSize: '0.75rem' }}>#</th>
                    <th style={{ padding: '14px 16px', textAlign: 'left', color: '#888', fontWeight: '600', fontSize: '0.75rem' }}>TOKEN</th>
                    <th style={{ padding: '14px 16px', textAlign: 'left', color: '#888', fontWeight: '600', fontSize: '0.75rem' }}>NETWORK</th>
                    <th style={{ padding: '14px 16px', textAlign: 'right', color: '#888', fontWeight: '600', fontSize: '0.75rem' }}>PRICE</th>
                    <th style={{ padding: '14px 16px', textAlign: 'right', color: '#888', fontWeight: '600', fontSize: '0.75rem' }}>24H %</th>
                    <th style={{ padding: '14px 16px', textAlign: 'right', color: '#888', fontWeight: '600', fontSize: '0.75rem' }}>MARKET CAP</th>
                    <th style={{ padding: '14px 16px', textAlign: 'right', color: '#888', fontWeight: '600', fontSize: '0.75rem' }}>24H VOLUME</th>
                    <th style={{ padding: '14px 16px', textAlign: 'right', color: '#888', fontWeight: '600', fontSize: '0.75rem' }}>TRACK</th>
                  </tr>
                </thead>
                <tbody>
                  {displayTokens.map((token, idx) => (
                    <TokenRow
                      key={token.id}
                      token={token}
                      rank={startIndex + idx + 1}
                      onTrack={handleTrack}
                      isTracked={isTokenTracked(token)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Pagination */}
          <Pagination 
            currentPage={currentPage}
            totalPages={totalPages}
            onPageChange={setCurrentPage}
          />
        </>
      )}
    </div>
  );
};

// ============================================
// TOKEN SEARCH COMPONENT (with ticker search)
// ============================================

const TokenSearch = ({ tokens, selectedToken, onSelect, onAddToken, onRemoveToken }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState([]);
  const [showResults, setShowResults] = useState(false);

  // Debounced search
  useEffect(() => {
    if (!searchQuery || searchQuery.length < 2) {
      setSearchResults([]);
      setShowResults(false);
      return;
    }

    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        // Check if it looks like a contract address
        const isAddress = searchQuery.startsWith('0x') || searchQuery.length > 30;
        
        if (isAddress) {
          // Direct add for contract addresses
          setSearchResults([{
            id: searchQuery,
            symbol: 'CUSTOM',
            name: 'Custom Token',
            isAddress: true
          }]);
          setShowResults(true);
        } else {
          // Search by ticker/name using CoinGecko
          const response = await fetch(
            '/api/moralis?source=coingecko&endpoint=' + encodeURIComponent(`/search?query=${searchQuery}`)
          );
          
          if (response.ok) {
            const data = await response.json();
            const coins = (data.coins || []).slice(0, 10);
            setSearchResults(coins);
            setShowResults(coins.length > 0);
          }
        }
      } catch (err) {
        console.error('Search error:', err);
      } finally {
        setSearching(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [searchQuery]);

  const handleSelectResult = async (result) => {
    setSearching(true);
    
    try {
      if (result.isAddress) {
        // Direct contract address - try to detect chain from address format
        let detectedChain = 'eth'; // default
        if (searchQuery.length >= 32 && searchQuery.length <= 44 && !searchQuery.startsWith('0x')) {
          detectedChain = 'solana';
        }
        
        onAddToken({
          address: searchQuery,
          symbol: 'CUSTOM',
          name: 'Custom Token',
          chain: detectedChain,
          logo: '🪙',
          hasContractAddress: true
        });
      } else {
        // Fetch token details from CoinGecko to get contract address
        const response = await fetch(
          '/api/moralis?source=coingecko&endpoint=' + encodeURIComponent(`/coins/${result.id}`)
        );
        
        if (response.ok) {
          const data = await response.json();
          
          // Find first available contract address and chain
          let contractAddress = null;
          let actualChain = 'eth';
          
          if (data.platforms) {
            // Priority order for chains
            const chainPriority = ['ethereum', 'base', 'arbitrum-one', 'polygon-pos', 'binance-smart-chain', 'solana'];
            
            for (const platform of chainPriority) {
              if (data.platforms[platform] && COINGECKO_PLATFORM_MAP[platform]) {
                contractAddress = data.platforms[platform];
                actualChain = COINGECKO_PLATFORM_MAP[platform];
                break;
              }
            }
            
            // If no priority chain found, try any available
            if (!contractAddress) {
              for (const [platform, address] of Object.entries(data.platforms)) {
                if (address && COINGECKO_PLATFORM_MAP[platform]) {
                  contractAddress = address;
                  actualChain = COINGECKO_PLATFORM_MAP[platform];
                  break;
                }
              }
            }
          }
          
          onAddToken({
            address: contractAddress || result.id,
            symbol: result.symbol?.toUpperCase() || 'UNKNOWN',
            name: result.name || 'Unknown Token',
            chain: actualChain,
            logo: result.large || result.thumb || '🪙',
            coingeckoId: result.id,
            hasContractAddress: !!contractAddress
          });
        }
      }
    } catch (err) {
      console.error('Failed to add token:', err);
    } finally {
      setSearching(false);
      setSearchQuery('');
      setShowResults(false);
    }
  };

  return (
    <div style={{ marginBottom: '24px' }}>
      {/* Search Bar */}
      <div style={{
        background: THEME.bg.secondary,
        border: `1px solid ${THEME.border.default}`,
        borderRadius: '8px',
        padding: '16px',
        marginBottom: '16px',
        position: 'relative'
      }}>
        <div style={{ 
          fontSize: '0.75rem', 
          color: THEME.text.secondary, 
          marginBottom: '12px'
        }}>
          Search by token ticker, name, or contract address
        </div>
        <div style={{
          display: 'flex',
          gap: '12px',
          alignItems: 'flex-end',
          flexWrap: 'wrap'
        }}>
          <div style={{ flex: '1', minWidth: '300px', position: 'relative' }}>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search: ETH, Bitcoin, 0x..."
              style={{
                width: '100%',
                padding: '10px 14px',
                background: THEME.bg.primary,
                border: `1px solid ${THEME.border.default}`,
                borderRadius: '6px',
                color: THEME.text.primary,
                fontSize: '0.875rem',
                outline: 'none'
              }}
            />
            
            {/* Search Results Dropdown */}
            {showResults && (
              <div style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                right: 0,
                background: THEME.bg.secondary,
                border: `1px solid ${THEME.border.default}`,
                borderRadius: '6px',
                marginTop: '4px',
                maxHeight: '300px',
                overflowY: 'auto',
                zIndex: 100
              }}>
                {searchResults.map((result, idx) => (
                  <div
                    key={result.id || idx}
                    onClick={() => handleSelectResult(result)}
                    style={{
                      padding: '10px 14px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '12px',
                      cursor: 'pointer',
                      borderBottom: `1px solid ${THEME.border.subtle}`,
                      transition: 'background 0.15s'
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = THEME.bg.tertiary}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    {result.thumb && (
                      <img 
                        src={result.thumb} 
                        alt="" 
                        style={{ width: '24px', height: '24px', borderRadius: '50%' }}
                      />
                    )}
                    <div>
                      <div style={{ fontWeight: '500', color: THEME.text.primary }}>
                        {result.symbol?.toUpperCase()}
                      </div>
                      <div style={{ fontSize: '0.75rem', color: THEME.text.secondary }}>
                        {result.name}
                      </div>
                    </div>
                    {result.market_cap_rank && (
                      <span style={{ 
                        marginLeft: 'auto', 
                        fontSize: '0.7rem', 
                        color: THEME.text.muted 
                      }}>
                        #{result.market_cap_rank}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          
          {searching && (
            <LoadingSpinner size={20} />
          )}}
        </div>
      </div>

      {/* Tracked Tokens */}
      {tokens.length > 0 && (
        <div>
          <div style={{ 
            fontSize: '0.75rem', 
            color: '#888', 
            marginBottom: '12px',
            textTransform: 'uppercase',
            letterSpacing: '1px'
          }}>
            Your Tracked Tokens ({tokens.length})
          </div>
          <div style={{ 
            display: 'flex', 
            gap: '8px', 
            flexWrap: 'wrap',
            alignItems: 'center'
          }}>
            {tokens.map((token) => (
              <div
                key={`${token.chain}-${token.address}`}
                style={{
                  padding: '10px 16px',
                  background: selectedToken?.address === token.address 
                    ? 'linear-gradient(135deg, #7b2ff7 0%, #f107a3 100%)'
                    : 'rgba(255,255,255,0.05)',
                  border: selectedToken?.address === token.address 
                    ? 'none'
                    : '1px solid rgba(255,255,255,0.1)',
                  borderRadius: '10px',
                  color: '#fff',
                  fontSize: '0.85rem',
                  fontWeight: '600',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px'
                }}
              >
                <button
                  onClick={() => onSelect(token)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#fff',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: 0
                  }}
                >
                  <span style={{ fontSize: '1.1rem' }}>
                    {typeof token.logo === 'string' && token.logo.startsWith('http') ? (
                      <img src={token.logo} alt="" style={{ width: '20px', height: '20px', borderRadius: '50%' }} />
                    ) : (
                      token.logo || '🪙'
                    )}
                  </span>
                  <span>{token.symbol}</span>
                  <NetworkBadge chain={token.chain} small />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveToken(token);
                  }}
                  style={{
                    background: 'rgba(239, 68, 68, 0.2)',
                    border: 'none',
                    borderRadius: '4px',
                    color: '#ef4444',
                    cursor: 'pointer',
                    padding: '2px 6px',
                    fontSize: '0.7rem',
                    marginLeft: '4px'
                  }}
                  title="Remove token"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================
// STAT CARD COMPONENT
// ============================================

const StatCard = ({ label, value, icon, subValue }) => (
  <div style={{
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: '12px',
    padding: '16px 20px',
    display: 'flex',
    alignItems: 'center',
    gap: '16px'
  }}>
    <div style={{
      width: '48px',
      height: '48px',
      background: 'linear-gradient(135deg, rgba(123, 47, 247, 0.2) 0%, rgba(241, 7, 163, 0.2) 100%)',
      borderRadius: '10px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: '1.5rem'
    }}>
      {icon}
    </div>
    <div>
      <div style={{ 
        fontSize: '0.7rem', 
        color: '#888', 
        textTransform: 'uppercase',
        letterSpacing: '1px',
        marginBottom: '4px'
      }}>
        {label}
      </div>
      <div style={{ 
        fontSize: '1.25rem', 
        fontWeight: '700',
        color: '#fff'
      }}>
        {value}
      </div>
      {subValue && (
        <div style={{ fontSize: '0.7rem', color: '#666', marginTop: '2px' }}>
          {subValue}
        </div>
      )}
    </div>
  </div>
);

// ============================================
// MAIN APP COMPONENT
// ============================================

export default function App() {
  // View state
  const [activeView, setActiveView] = useState('market');
  const [walletViewChain, setWalletViewChain] = useState('eth');
  
  // Token management
  const [tokens, setTokens] = useState(() => {
    const saved = localStorage.getItem('trackedTokens');
    return saved ? JSON.parse(saved) : [];
  });
  const [selectedToken, setSelectedToken] = useState(() => {
    const saved = localStorage.getItem('selectedToken');
    return saved ? JSON.parse(saved) : null;
  });

  // Data state
  const [holders, setHolders] = useState([]);
  const [previousHolders, setPreviousHolders] = useState({});
  const [transfers, setTransfers] = useState([]);
  const [tokenInfo, setTokenInfo] = useState(null);
  const [tokenPrice, setTokenPrice] = useState(0);
  const [snapshotComparison, setSnapshotComparison] = useState({ 
    newWhales: [], 
    exitedWhales: [], 
    changes: {} 
  });
  
  // Phase 4: Price history and wallet profiler
  const [priceHistory, setPriceHistory] = useState([]);
  const [priceTimeframe, setPriceTimeframe] = useState('7'); // days
  const [poolsData, setPoolsData] = useState([]);
  const [selectedWallet, setSelectedWallet] = useState(null);
  const [walletData, setWalletData] = useState(null);
  const [walletLoading, setWalletLoading] = useState(false);
  
  // UI state
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [lastSnapshot, setLastSnapshot] = useState(null);
  const [timeRemaining, setTimeRemaining] = useState(SNAPSHOT_INTERVAL);
  const [sortConfig, setSortConfig] = useState({ key: 'balance', direction: 'desc' });
  const [activeTab, setActiveTab] = useState('holders');
  
  // Pagination state
  const [holderPage, setHolderPage] = useState(1);
  const [txPage, setTxPage] = useState(1);
  
  // Transaction filter state
  const [txMinAmount, setTxMinAmount] = useState(0);
  const [txType, setTxType] = useState('all');

  // Save tokens to localStorage
  useEffect(() => {
    localStorage.setItem('trackedTokens', JSON.stringify(tokens));
  }, [tokens]);

  useEffect(() => {
    if (selectedToken) {
      localStorage.setItem('selectedToken', JSON.stringify(selectedToken));
    }
  }, [selectedToken]);

  // Check if token has a valid contract address for Moralis
  const canFetchFromMoralis = (token) => {
    if (!token?.hasContractAddress || !token?.address) return false;
    
    // Solana addresses are base58 encoded, typically 32-44 characters
    if (token.chain === 'solana') {
      return token.address.length >= 32 && token.address.length <= 44;
    }
    
    // EVM addresses start with 0x
    return token.address.startsWith('0x');
  };

  // API fetch function
  const fetchFromAPI = async (endpoint, chain) => {
    const isSolana = chain === 'solana';
    const url = `/api/moralis?endpoint=${encodeURIComponent(endpoint)}${isSolana ? '&chain=solana' : ''}`;
    const response = await fetch(url);
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `API Error: ${response.status}`);
    }
    return response.json();
  };

  // Fetch token metadata and market data
  const fetchTokenInfo = useCallback(async () => {
    if (!selectedToken || !canFetchFromMoralis(selectedToken)) return null;
    
    // Try CoinGecko first if we have coingeckoId (more reliable for market data)
    if (selectedToken.coingeckoId) {
      try {
        const response = await fetch(
          `/api/moralis?source=coingecko&endpoint=${encodeURIComponent(`/coins/${selectedToken.coingeckoId}?localization=false&tickers=false&community_data=false&developer_data=false`)}`
        );
        if (response.ok) {
          const data = await response.json();
          return {
            symbol: data.symbol?.toUpperCase(),
            name: data.name,
            decimals: data.detail_platforms?.[NETWORKS[selectedToken.chain]?.coingeckoId]?.decimal_place || 18,
            logo: data.image?.large || data.image?.small,
            market_cap: data.market_data?.market_cap?.usd,
            total_volume: data.market_data?.total_volume?.usd,
            price_change_24h: data.market_data?.price_change_percentage_24h,
            circulating_supply: data.market_data?.circulating_supply,
            total_supply: data.market_data?.total_supply,
            max_supply: data.market_data?.max_supply,
            ath: data.market_data?.ath?.usd,
            ath_date: data.market_data?.ath_date?.usd,
            atl: data.market_data?.atl?.usd,
            atl_date: data.market_data?.atl_date?.usd,
            fully_diluted_valuation: data.market_data?.fully_diluted_valuation?.usd,
            links: {
              homepage: data.links?.homepage?.[0],
              twitter: data.links?.twitter_screen_name ? `https://twitter.com/${data.links.twitter_screen_name}` : null,
              telegram: data.links?.telegram_channel_identifier ? `https://t.me/${data.links.telegram_channel_identifier}` : null,
              discord: data.links?.chat_url?.find(u => u.includes('discord')),
              github: data.links?.repos_url?.github?.[0]
            },
            description: data.description?.en?.slice(0, 500),
            categories: data.categories,
            contract_address: selectedToken.address
          };
        }
      } catch (err) {
        console.error('CoinGecko token info fetch error:', err);
      }
    }
    
    // Fallback to Moralis for EVM chains
    if (selectedToken.chain !== 'solana') {
      try {
        const data = await fetchFromAPI(
          `/erc20/metadata?chain=${selectedToken.chain}&addresses[]=${selectedToken.address}`
        );
        return data[0] || null;
      } catch (err) {
        console.error('Token info fetch error:', err);
        return null;
      }
    }
    
    // Solana fallback - use basic info from selection
    return {
      symbol: selectedToken.symbol,
      name: selectedToken.name,
      decimals: 9,
      logo: selectedToken.logo
    };
  }, [selectedToken]);

  // Fetch token price (CoinGecko primary, Moralis fallback for EVM only)
  const fetchTokenPrice = useCallback(async () => {
    if (!selectedToken) return 0;
    
    // Try CoinGecko first if we have coingeckoId (works for all chains including Solana)
    if (selectedToken.coingeckoId) {
      try {
        const response = await fetch(
          `/api/moralis?source=coingecko&endpoint=${encodeURIComponent(`/simple/price?ids=${selectedToken.coingeckoId}&vs_currencies=usd`)}`
        );
        if (response.ok) {
          const data = await response.json();
          if (data[selectedToken.coingeckoId]?.usd) {
            return data[selectedToken.coingeckoId].usd;
          }
        }
      } catch (err) {
        console.error('CoinGecko price fetch error:', err);
      }
    }
    
    // Fallback to Moralis for EVM chains only (Solana API is unreliable)
    if (!canFetchFromMoralis(selectedToken) || selectedToken.chain === 'solana') return 0;
    
    try {
      const data = await fetchFromAPI(
        `/erc20/${selectedToken.address}/price?chain=${selectedToken.chain}`
      );
      return data.usdPrice || 0;
    } catch (err) {
      console.error('Price fetch error:', err);
      return 0;
    }
  }, [selectedToken]);

  // Fetch top holders
  const fetchHolders = useCallback(async () => {
    if (!selectedToken || !canFetchFromMoralis(selectedToken)) return [];
    
    // For Solana, we can't reliably get holders from Moralis
    if (selectedToken.chain === 'solana') {
      console.log('Solana holder data not available via current APIs');
      return [];
    }
    
    try {
      // Check if we should do multi-chain aggregation
      // This requires the token to have a coingeckoId to look up other chain addresses
      let allHolders = [];
      let chainsFetched = [selectedToken.chain];
      
      // Fetch from primary chain first
      const primaryData = await fetchFromAPI(
        `/erc20/${selectedToken.address}/owners?chain=${selectedToken.chain}&limit=100&order=DESC`
      );
      const primaryHolders = (primaryData.result || []).map(h => ({
        ...h,
        chain: selectedToken.chain,
        chainName: NETWORKS[selectedToken.chain]?.name
      }));
      allHolders.push(...primaryHolders);
      
      // If token has coingeckoId, try to fetch from other chains too
      if (selectedToken.coingeckoId) {
        try {
          const coingeckoRes = await fetch(
            `/api/moralis?source=coingecko&endpoint=${encodeURIComponent(`/coins/${selectedToken.coingeckoId}`)}`
          );
          if (coingeckoRes.ok) {
            const cgData = await coingeckoRes.json();
            const platforms = cgData.platforms || {};
            
            // Map CoinGecko platform names to our chain keys
            const platformToChain = {
              'ethereum': 'eth',
              'arbitrum-one': 'arbitrum',
              'base': 'base',
              'polygon-pos': 'polygon',
              'binance-smart-chain': 'bsc'
            };
            
            // Fetch from other chains (limit to avoid too many requests)
            const otherChainPromises = [];
            for (const [platform, address] of Object.entries(platforms)) {
              const chainKey = platformToChain[platform];
              if (chainKey && chainKey !== selectedToken.chain && address) {
                chainsFetched.push(chainKey);
                otherChainPromises.push(
                  fetchFromAPI(`/erc20/${address}/owners?chain=${chainKey}&limit=50&order=DESC`)
                    .then(data => (data.result || []).map(h => ({
                      ...h,
                      chain: chainKey,
                      chainName: NETWORKS[chainKey]?.name
                    })))
                    .catch(() => [])
                );
              }
            }
            
            if (otherChainPromises.length > 0) {
              const otherResults = await Promise.all(otherChainPromises);
              otherResults.forEach(holders => allHolders.push(...holders));
            }
          }
        } catch (e) {
          console.log('Could not fetch multi-chain data:', e);
        }
      }
      
      // Aggregate holders by address (same wallet across chains)
      const holderMap = new Map();
      allHolders.forEach(h => {
        const addr = h.owner_address?.toLowerCase();
        if (!addr) return;
        
        if (holderMap.has(addr)) {
          const existing = holderMap.get(addr);
          existing.balance = (parseFloat(existing.balance) || 0) + (parseFloat(h.balance) || 0);
          existing.balance_formatted = (parseFloat(existing.balance_formatted) || 0) + (parseFloat(h.balance_formatted) || 0);
          existing.percentage_relative_to_total_supply = (parseFloat(existing.percentage_relative_to_total_supply) || 0) + (parseFloat(h.percentage_relative_to_total_supply) || 0);
          if (!existing.chains.includes(h.chain)) {
            existing.chains.push(h.chain);
          }
        } else {
          holderMap.set(addr, {
            ...h,
            chains: [h.chain]
          });
        }
      });
      
      // Convert to array and sort by balance
      const aggregatedHolders = Array.from(holderMap.values())
        .sort((a, b) => parseFloat(b.balance_formatted || b.balance || 0) - parseFloat(a.balance_formatted || a.balance || 0))
        .slice(0, 100);
      
      // Add metadata about the fetch
      aggregatedHolders.chainsFetched = chainsFetched;
      aggregatedHolders.isMultiChain = chainsFetched.length > 1;
      
      return aggregatedHolders;
    } catch (err) {
      console.error('Holders fetch error:', err);
      return [];
    }
  }, [selectedToken]);

  // Fetch recent transactions (transfers + swaps/trades)
  // Fetch recent trades from GeckoTerminal (free API with direct swap data)
  const fetchGeckoTerminalTrades = useCallback(async () => {
    const network = NETWORKS[selectedToken?.chain];
    if (!network?.geckoTerminalId || !selectedToken?.address) return [];
    
    try {
      // First get pools for this token
      const poolsUrl = `/api/moralis?source=geckoterminal&endpoint=${encodeURIComponent(
        `/networks/${network.geckoTerminalId}/tokens/${selectedToken.address}/pools?page=1`
      )}`;
      
      const poolsResponse = await fetch(poolsUrl);
      if (!poolsResponse.ok) return [];
      
      const poolsData = await poolsResponse.json();
      const pools = poolsData?.data || [];
      if (pools.length === 0) return [];
      
      // Get trades from top 3 pools
      const allTrades = [];
      for (const pool of pools.slice(0, 3)) {
        const poolAddress = pool.attributes?.address || pool.id?.split('_')[1];
        if (!poolAddress) continue;
        
        try {
          const tradesUrl = `/api/moralis?source=geckoterminal&endpoint=${encodeURIComponent(
            `/networks/${network.geckoTerminalId}/pools/${poolAddress}/trades`
          )}`;
          
          const tradesResponse = await fetch(tradesUrl);
          if (!tradesResponse.ok) continue;
          
          const tradesData = await tradesResponse.json();
          const trades = tradesData?.data || [];
          
          const mappedTrades = trades.map(trade => {
            const attrs = trade.attributes || {};
            const isBuy = attrs.kind === 'buy';
            
            return {
              transaction_hash: attrs.tx_hash,
              block_timestamp: attrs.block_timestamp,
              trader_address: attrs.tx_from_address || '',
              amount: parseFloat(isBuy ? attrs.to_token_amount : attrs.from_token_amount) || 0,
              usdValue: parseFloat(attrs.volume_in_usd) || 0,
              type: isBuy ? 'buy' : 'sell',
              source: 'geckoterminal',
              pool_name: pool.attributes?.name || 'Unknown Pool',
              pool_address: poolAddress
            };
          });
          
          allTrades.push(...mappedTrades);
        } catch (e) {
          console.log('GeckoTerminal pool error:', e);
        }
      }
      
      return allTrades;
    } catch (err) {
      console.error('GeckoTerminal error:', err);
      return [];
    }
  }, [selectedToken]);

  // Fetch trades from DexScreener (backup/additional source)
  const fetchDexScreenerTrades = useCallback(async () => {
    const network = NETWORKS[selectedToken?.chain];
    if (!network?.dexScreenerId || !selectedToken?.address) return [];
    
    try {
      const url = `/api/moralis?source=dexscreener&endpoint=${encodeURIComponent(
        `/latest/dex/tokens/${selectedToken.address}`
      )}`;
      
      const response = await fetch(url);
      if (!response.ok) return [];
      
      const data = await response.json();
      const pairs = data?.pairs || [];
      
      // DexScreener doesn't provide individual trades in the free API,
      // but we can get recent txns from the pairs endpoint
      // For now, we'll use it as supplementary pool info
      // The main value is the price and liquidity data
      
      return []; // DexScreener free API doesn't have trade history
    } catch (err) {
      console.error('DexScreener error:', err);
      return [];
    }
  }, [selectedToken]);

  // Fetch transfers from Moralis (EVM chains only - wallet-to-wallet movements, no mints/burns)
  const fetchMoralisTransfers = useCallback(async () => {
    // Skip Moralis for Solana - use GeckoTerminal trades instead
    if (!selectedToken || !canFetchFromMoralis(selectedToken) || selectedToken.chain === 'solana') {
      return [];
    }
    
    try {
      const transfersData = await fetchFromAPI(
        `/erc20/${selectedToken.address}/transfers?chain=${selectedToken.chain}&limit=100`
      );
      
      if (!transfersData?.result) return [];
      
      // Filter and map transfers - exclude mints and burns
      return transfersData.result
        .filter(t => {
          const fromLower = (t.from_address || '').toLowerCase();
          const toLower = (t.to_address || '').toLowerCase();
          const zeroAddress = '0x0000000000000000000000000000000000000000';
          // Exclude mints (from zero address) and burns (to zero address)
          return fromLower !== zeroAddress && toLower !== zeroAddress;
        })
        .map(t => {
          const decimals = parseInt(t.token_decimals || tokenInfo?.decimals || 18);
          const amount = parseFloat(t.value || 0) / Math.pow(10, decimals);
          
          return {
            transaction_hash: t.transaction_hash,
            block_timestamp: t.block_timestamp,
            from_address: t.from_address,
            to_address: t.to_address,
            trader_address: t.from_address,
            amount,
            usdValue: amount * tokenPrice,
            type: 'transfer',
            source: 'moralis'
          };
        });
    } catch (err) {
      console.error('Moralis transfers error:', err);
      return [];
    }
  }, [selectedToken, tokenInfo, tokenPrice]);

  // Combined fetch function - gets data from all sources
  const fetchTransfers = useCallback(async () => {
    if (!selectedToken) return [];
    
    try {
      // Fetch from all sources in parallel
      const [geckoTrades, moralisTransfers] = await Promise.all([
        fetchGeckoTerminalTrades(),
        fetchMoralisTransfers()
      ]);
      
      // Combine all transactions
      const allTransactions = [...geckoTrades, ...moralisTransfers];
      
      // Remove duplicates by transaction hash
      const uniqueTransactions = allTransactions.reduce((acc, tx) => {
        const existing = acc.find(t => t.transaction_hash === tx.transaction_hash);
        if (!existing) {
          acc.push(tx);
        } else if (tx.source === 'geckoterminal' && existing.source === 'moralis') {
          // Prefer GeckoTerminal data for swaps (has better USD values)
          const idx = acc.indexOf(existing);
          acc[idx] = tx;
        }
        return acc;
      }, []);
      
      // Sort by timestamp (most recent first)
      return uniqueTransactions.sort((a, b) => {
        const dateA = new Date(a.block_timestamp || 0);
        const dateB = new Date(b.block_timestamp || 0);
        return dateB - dateA;
      });
      
    } catch (err) {
      console.error('Combined fetch error:', err);
      return [];
    }
  }, [selectedToken, fetchGeckoTerminalTrades, fetchMoralisTransfers]);

  // Load all data
  const loadSnapshot = useCallback(async () => {
    if (!selectedToken) return;
    
    if (!canFetchFromMoralis(selectedToken)) {
      setError(`Cannot fetch on-chain data for ${selectedToken.symbol}. This token doesn't have a valid contract address on ${NETWORKS[selectedToken.chain]?.name || selectedToken.chain}. Try searching for it with a different network or use the contract address directly.`);
      setLoading(false);
      return;
    }
    
    setLoading(true);
    setError(null);
    
    try {
      const [holdersData, price, transfersData, info] = await Promise.all([
        fetchHolders(),
        fetchTokenPrice(),
        fetchTransfers(),
        fetchTokenInfo()
      ]);

      // Get previous snapshot for comparison before saving new one
      const previousSnapshot = SnapshotManager.getLatest(selectedToken.address, selectedToken.chain);
      
      // Save new snapshot
      const snapshots = SnapshotManager.save(selectedToken.address, selectedToken.chain, holdersData);
      const currentSnapshot = snapshots[snapshots.length - 1];
      
      // Calculate comparison
      if (previousSnapshot && currentSnapshot) {
        const comparison = SnapshotManager.compareSnapshots(currentSnapshot, previousSnapshot);
        setSnapshotComparison(comparison);
      } else {
        setSnapshotComparison({ newWhales: [], exitedWhales: [], changes: {} });
      }

      setHolders(holdersData);
      setTokenPrice(price);
      setTransfers(transfersData);
      setTokenInfo(info);
      setLastSnapshot(new Date());
      setTimeRemaining(SNAPSHOT_INTERVAL);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [fetchHolders, fetchTokenPrice, fetchTransfers, fetchTokenInfo, selectedToken]);

  // Fetch price history from CoinGecko
  const fetchPriceHistory = useCallback(async (days = 7) => {
    if (!selectedToken?.coingeckoId) return [];
    
    try {
      const response = await fetch(
        `/api/moralis?source=coingecko&endpoint=${encodeURIComponent(
          `/coins/${selectedToken.coingeckoId}/market_chart?vs_currency=usd&days=${days}`
        )}`
      );
      
      if (response.ok) {
        const data = await response.json();
        return (data.prices || []).map(([timestamp, price]) => ({
          time: new Date(timestamp).toLocaleDateString(),
          timestamp,
          price
        }));
      }
    } catch (err) {
      console.error('Price history fetch error:', err);
    }
    return [];
  }, [selectedToken]);

  // Fetch liquidity pools from GeckoTerminal
  const fetchPools = useCallback(async () => {
    if (!selectedToken?.address) return [];
    
    try {
      let allPools = [];
      let chainsToFetch = [];
      
      // Primary chain
      const primaryNetwork = NETWORKS[selectedToken.chain];
      if (primaryNetwork?.geckoTerminalId) {
        chainsToFetch.push({ chain: selectedToken.chain, address: selectedToken.address, network: primaryNetwork });
      }
      
      // If token has coingeckoId, try to get pools from other chains too
      if (selectedToken.coingeckoId) {
        try {
          const coingeckoRes = await fetch(
            `/api/moralis?source=coingecko&endpoint=${encodeURIComponent(`/coins/${selectedToken.coingeckoId}`)}`
          );
          if (coingeckoRes.ok) {
            const cgData = await coingeckoRes.json();
            const platforms = cgData.platforms || {};
            
            const platformToChain = {
              'ethereum': 'eth',
              'arbitrum-one': 'arbitrum',
              'base': 'base',
              'polygon-pos': 'polygon',
              'binance-smart-chain': 'bsc'
            };
            
            for (const [platform, address] of Object.entries(platforms)) {
              const chainKey = platformToChain[platform];
              if (chainKey && chainKey !== selectedToken.chain && address && NETWORKS[chainKey]?.geckoTerminalId) {
                chainsToFetch.push({ 
                  chain: chainKey, 
                  address: address, 
                  network: NETWORKS[chainKey] 
                });
              }
            }
          }
        } catch (e) {
          console.log('Could not fetch multi-chain pool data:', e);
        }
      }
      
      // Fetch pools from all chains in parallel
      const poolPromises = chainsToFetch.map(async ({ chain, address, network }) => {
        try {
          const response = await fetch(
            `/api/moralis?source=geckoterminal&endpoint=${encodeURIComponent(
              `/networks/${network.geckoTerminalId}/tokens/${address}/pools?page=1`
            )}`
          );
          
          if (response.ok) {
            const data = await response.json();
            return (data.data || []).map(pool => ({
              address: pool.attributes?.address,
              name: pool.attributes?.name,
              dex: pool.relationships?.dex?.data?.id,
              chain: chain,
              chainName: network.name,
              price_usd: parseFloat(pool.attributes?.base_token_price_usd) || 0,
              liquidity_usd: parseFloat(pool.attributes?.reserve_in_usd) || 0,
              volume_24h: parseFloat(pool.attributes?.volume_usd?.h24) || 0,
              price_change_24h: parseFloat(pool.attributes?.price_change_percentage?.h24) || 0,
              transactions_24h: (pool.attributes?.transactions?.h24?.buys || 0) + (pool.attributes?.transactions?.h24?.sells || 0),
              buys_24h: pool.attributes?.transactions?.h24?.buys || 0,
              sells_24h: pool.attributes?.transactions?.h24?.sells || 0
            }));
          }
        } catch (e) {
          console.log(`Pool fetch error for ${chain}:`, e);
        }
        return [];
      });
      
      const poolResults = await Promise.all(poolPromises);
      allPools = poolResults.flat();
      
      // Sort by liquidity
      allPools.sort((a, b) => b.liquidity_usd - a.liquidity_usd);
      
      // Add metadata
      allPools.isMultiChain = chainsToFetch.length > 1;
      allPools.chainsFetched = chainsToFetch.map(c => c.chain);
      
      return allPools;
    } catch (err) {
      console.error('Pools fetch error:', err);
    }
    return [];
  }, [selectedToken]);

  // Fetch wallet data (portfolio + transactions)
  const fetchWalletData = useCallback(async (walletAddress, chainOverride = null, multiChain = false) => {
    if (!walletAddress) return null;
    
    setWalletLoading(true);
    
    try {
      // For EVM addresses, fetch from all chains if multiChain is true
      const isEvmAddress = walletAddress.startsWith('0x') && walletAddress.length === 42;
      
      if (!isEvmAddress) {
        // Solana wallet data - not available via current API
        setWalletLoading(false);
        return {
          address: walletAddress,
          chains: ['solana'],
          portfolio: [],
          total_value: 0,
          token_count: 0,
          message: 'Solana wallet data not available via current API'
        };
      }
      
      // Determine which chains to fetch
      const evmChains = ['eth', 'arbitrum', 'base', 'polygon', 'bsc'];
      const chainsToFetch = multiChain ? evmChains : [chainOverride || selectedToken?.chain || walletViewChain || 'eth'];
      
      // Fetch portfolio from all requested chains in parallel
      const portfolioPromises = chainsToFetch.map(async (chain) => {
        try {
          const res = await fetch(`/api/moralis?endpoint=${encodeURIComponent(`/wallets/${walletAddress}/tokens?chain=${chain}`)}`);
          if (res.ok) {
            const data = await res.json();
            const tokens = data.result || data || [];
            return tokens.map(t => ({
              ...t,
              chain,
              chainName: NETWORKS[chain]?.name || chain
            }));
          }
        } catch (e) {
          console.error(`Error fetching ${chain} portfolio:`, e);
        }
        return [];
      });
      
      const allPortfolios = await Promise.all(portfolioPromises);
      const combinedPortfolio = allPortfolios.flat();
      
      // Aggregate same tokens across chains
      const tokenMap = new Map();
      combinedPortfolio.forEach(t => {
        const key = t.symbol?.toLowerCase() || t.token_address;
        const usdValue = parseFloat(t.usd_value) || (parseFloat(t.balance_formatted || 0) * parseFloat(t.usd_price || 0));
        
        if (tokenMap.has(key)) {
          const existing = tokenMap.get(key);
          existing.usd_value += usdValue;
          existing.chains.push(t.chain);
          existing.balances.push({
            chain: t.chain,
            balance: parseFloat(t.balance_formatted) || 0,
            usd_value: usdValue
          });
        } else {
          tokenMap.set(key, {
            token_address: t.token_address,
            symbol: t.symbol || 'Unknown',
            name: t.name || 'Unknown Token',
            balance: parseFloat(t.balance_formatted) || parseFloat(t.balance) / Math.pow(10, t.decimals || 18) || 0,
            decimals: t.decimals || 18,
            logo: t.logo || t.thumbnail,
            usd_value: usdValue,
            usd_price: parseFloat(t.usd_price) || 0,
            chains: [t.chain],
            balances: [{
              chain: t.chain,
              balance: parseFloat(t.balance_formatted) || 0,
              usd_value: usdValue
            }]
          });
        }
      });
      
      // Convert to array and sort by value
      const aggregatedPortfolio = Array.from(tokenMap.values())
        .sort((a, b) => b.usd_value - a.usd_value);
      
      const totalValue = aggregatedPortfolio.reduce((sum, t) => sum + t.usd_value, 0);
      
      // Fetch history from primary chain only (to avoid too many requests)
      const primaryChain = chainOverride || selectedToken?.chain || walletViewChain || 'eth';
      let history = [];
      try {
        const historyRes = await fetch(`/api/moralis?endpoint=${encodeURIComponent(`/wallets/${walletAddress}/history?chain=${primaryChain}&limit=50`)}`);
        if (historyRes.ok) {
          const historyData = await historyRes.json();
          history = (historyData.result || []).slice(0, 30).map(tx => ({
            hash: tx.hash,
            timestamp: tx.block_timestamp,
            type: tx.category || 'transfer',
            value: tx.value,
            from: tx.from_address,
            to: tx.to_address,
            chain: primaryChain
          }));
        }
      } catch (e) {
        console.error('Error fetching history:', e);
      }
      
      return {
        address: walletAddress,
        chains: chainsToFetch,
        multiChain,
        portfolio: aggregatedPortfolio.slice(0, 50),
        history,
        total_value: totalValue,
        token_count: aggregatedPortfolio.length,
        chain_breakdown: chainsToFetch.map(chain => ({
          chain,
          name: NETWORKS[chain]?.name,
          value: combinedPortfolio
            .filter(t => t.chain === chain)
            .reduce((sum, t) => sum + (parseFloat(t.usd_value) || 0), 0)
        })).filter(c => c.value > 0)
      };
    } catch (err) {
      console.error('Wallet data fetch error:', err);
      return null;
    } finally {
      setWalletLoading(false);
    }
  }, [selectedToken, walletViewChain]);

  // Load price history when token or timeframe changes
  useEffect(() => {
    if (selectedToken?.coingeckoId && activeView === 'tracker') {
      fetchPriceHistory(parseInt(priceTimeframe)).then(setPriceHistory);
      fetchPools().then(setPoolsData);
    }
  }, [selectedToken, priceTimeframe, activeView, fetchPriceHistory, fetchPools]);

  // Load wallet data when a wallet is selected
  useEffect(() => {
    if (selectedWallet) {
      // Use multi-chain aggregation when coming from Wallet Tracker or when no specific token selected
      const useMultiChain = activeView === 'wallets' || !selectedToken;
      fetchWalletData(selectedWallet, walletViewChain, useMultiChain).then(setWalletData);
    } else {
      setWalletData(null);
    }
  }, [selectedWallet, walletViewChain, activeView, selectedToken, fetchWalletData]);

  // Load data when token changes
  useEffect(() => {
    if (activeView === 'tracker' && selectedToken) {
      loadSnapshot();
    }
  }, [selectedToken, activeView]);

  // Countdown timer
  useEffect(() => {
    if (activeView !== 'tracker' || !selectedToken) return;
    
    const timer = setInterval(() => {
      setTimeRemaining(prev => {
        if (prev <= 1000) {
          loadSnapshot();
          return SNAPSHOT_INTERVAL;
        }
        return prev - 1000;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [loadSnapshot, activeView, selectedToken]);

  // Add new token
  const handleAddToken = (token) => {
    const exists = tokens.some(t => 
      (t.address?.toLowerCase() === token.address?.toLowerCase() && t.chain === token.chain) ||
      (t.coingeckoId && t.coingeckoId === token.coingeckoId)
    );
    if (!exists) {
      const newTokens = [...tokens, token];
      setTokens(newTokens);
      setSelectedToken(token);
      setActiveView('tracker');
    } else {
      const existingToken = tokens.find(t => 
        (t.address?.toLowerCase() === token.address?.toLowerCase() && t.chain === token.chain) ||
        (t.coingeckoId && t.coingeckoId === token.coingeckoId)
      );
      if (existingToken) {
        setSelectedToken(existingToken);
        setActiveView('tracker');
      }
    }
  };

  // Remove token
  const handleRemoveToken = (tokenToRemove) => {
    const newTokens = tokens.filter(t => 
      !(t.address === tokenToRemove.address && t.chain === tokenToRemove.chain)
    );
    setTokens(newTokens);
    
    if (selectedToken?.address === tokenToRemove.address) {
      setSelectedToken(newTokens[0] || null);
    }
  };

  // Sort holders
  const sortedHolders = React.useMemo(() => {
    const sorted = [...holders];
    sorted.sort((a, b) => {
      let aVal, bVal;
      
      if (sortConfig.key === 'balance') {
        aVal = parseFloat(a.balance_formatted || a.balance) || 0;
        bVal = parseFloat(b.balance_formatted || b.balance) || 0;
      } else if (sortConfig.key === 'usd') {
        aVal = parseFloat(a.usd_value || 0);
        bVal = parseFloat(b.usd_value || 0);
      } else if (sortConfig.key === 'percentage') {
        aVal = parseFloat(a.percentage_relative_to_total_supply || 0);
        bVal = parseFloat(b.percentage_relative_to_total_supply || 0);
      } else if (sortConfig.key === 'change') {
        const aBalance = parseFloat(a.balance_formatted || a.balance) || 0;
        const bBalance = parseFloat(b.balance_formatted || b.balance) || 0;
        const aPrev = previousHolders[a.owner_address] || aBalance;
        const bPrev = previousHolders[b.owner_address] || bBalance;
        aVal = aBalance - aPrev;
        bVal = bBalance - bPrev;
      }
      
      return sortConfig.direction === 'desc' ? bVal - aVal : aVal - bVal;
    });
    return sorted;
  }, [holders, sortConfig, previousHolders]);

  const top10PercentCount = Math.max(1, Math.ceil(holders.length * 0.1));

  // Process transactions from all sources
  const processedTransfers = React.useMemo(() => {
    if (!transfers || transfers.length === 0) return [];
    
    // Data already has USD values from respective sources
    const withUsdValues = transfers.map(t => ({
      ...t,
      usdValue: t.usdValue || 0,
      amount: t.amount || 0,
      type: t.type || 'transfer'
    }));
    
    // Sort by USD value (largest first)
    const sortedByValue = [...withUsdValues].sort((a, b) => b.usdValue - a.usdValue);
    
    // Apply filters
    let filtered = sortedByValue;
    
    // Apply minimum USD filter if set
    if (txMinAmount > 0) {
      filtered = filtered.filter(t => t.usdValue >= txMinAmount);
    } else {
      // Auto mode: show top 100 transactions
      filtered = sortedByValue.slice(0, 100);
    }
    
    // Apply type filter
    if (txType !== 'all') {
      filtered = filtered.filter(t => t.type === txType);
    }
    
    return filtered;
  }, [transfers, txMinAmount, txType]);

  const paginatedTransfers = React.useMemo(() => {
    const start = (txPage - 1) * TRANSACTIONS_PER_PAGE;
    return processedTransfers.slice(start, start + TRANSACTIONS_PER_PAGE);
  }, [processedTransfers, txPage]);

  const handleSort = (key) => {
    setSortConfig(prev => ({
      key,
      direction: prev.key === key && prev.direction === 'desc' ? 'asc' : 'desc'
    }));
  };

  const SortIcon = ({ column }) => {
    if (sortConfig.key !== column) return <span style={{ opacity: 0.3 }}>↕</span>;
    return sortConfig.direction === 'desc' ? <span>↓</span> : <span>↑</span>;
  };

  const network = selectedToken ? (NETWORKS[selectedToken.chain] || NETWORKS.eth) : NETWORKS.eth;

  // ==========================================
  // RENDER
  // ==========================================

  return (
    <div style={{
      minHeight: '100vh',
      background: THEME.bg.primary,
      color: THEME.text.primary,
      fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, sans-serif',
      padding: '24px'
    }}>
      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
      
      <div style={{ maxWidth: '1200px', margin: '0 auto' }}>
        
        {/* Header */}
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '16px',
          marginBottom: '32px',
          paddingBottom: '24px',
          borderBottom: `1px solid ${THEME.border.default}`
        }}>
          <div>
            <h1 style={{
              fontSize: '1.5rem',
              fontWeight: '600',
              margin: '0 0 4px 0',
              color: THEME.text.primary,
              letterSpacing: '-0.5px'
            }}>
              Edge Analytics
            </h1>
            <p style={{ margin: 0, color: THEME.text.secondary, fontSize: '0.875rem' }}>
              On-chain token and wallet intelligence
            </p>
          </div>
          
          {/* View Toggle */}
          <div style={{
            display: 'flex',
            background: THEME.bg.secondary,
            borderRadius: '8px',
            padding: '3px',
            border: `1px solid ${THEME.border.default}`
          }}>
            <button
              onClick={() => setActiveView('market')}
              style={{
                padding: '8px 16px',
                background: activeView === 'market' ? THEME.accent.primary : 'transparent',
                border: 'none',
                borderRadius: '6px',
                color: activeView === 'market' ? '#fff' : THEME.text.secondary,
                fontSize: '0.8125rem',
                fontWeight: '500',
                cursor: 'pointer',
                transition: 'all 0.15s ease'
              }}
            >
              Market
            </button>
            <button
              onClick={() => setActiveView('tracker')}
              style={{
                padding: '8px 16px',
                background: activeView === 'tracker' ? THEME.accent.primary : 'transparent',
                border: 'none',
                borderRadius: '6px',
                color: activeView === 'tracker' ? '#fff' : THEME.text.secondary,
                fontSize: '0.8125rem',
                fontWeight: '500',
                cursor: 'pointer',
                transition: 'all 0.15s ease'
              }}
            >
              Tokens
            </button>
            <button
              onClick={() => setActiveView('wallets')}
              style={{
                padding: '8px 16px',
                background: activeView === 'wallets' ? THEME.accent.primary : 'transparent',
                border: 'none',
                borderRadius: '6px',
                color: activeView === 'wallets' ? '#fff' : THEME.text.secondary,
                fontSize: '0.8125rem',
                fontWeight: '500',
                cursor: 'pointer',
                transition: 'all 0.15s ease'
              }}
            >
              Wallets
            </button>
          </div>
        </div>

        {/* Market Overview View */}
        {activeView === 'market' && (
          <MarketOverview 
            onTrackToken={handleAddToken}
            trackedTokens={tokens}
          />
        )}

        {/* Token Tracker View */}
        {activeView === 'tracker' && (
          <>
            <TokenSearch
              tokens={tokens}
              selectedToken={selectedToken}
              onSelect={setSelectedToken}
              onAddToken={handleAddToken}
              onRemoveToken={handleRemoveToken}
            />

            {!selectedToken && (
              <div style={{
                background: 'rgba(255,255,255,0.02)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: '16px',
                padding: '60px 40px',
                textAlign: 'center'
              }}>
                <div style={{ fontSize: '3rem', marginBottom: '16px' }}>🔍</div>
                <h3 style={{ margin: '0 0 8px 0', color: '#fff' }}>No Token Selected</h3>
                <p style={{ color: '#888', margin: 0 }}>
                  Search for a token above by ticker (ETH, BTC) or contract address.
                </p>
              </div>
            )}

            {selectedToken && (
              <>
                {/* Timer Card */}
                <div style={{
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: '16px',
                  padding: '16px 24px',
                  marginBottom: '24px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: '16px'
                }}>
                  <div>
                    <div style={{ fontSize: '0.75rem', color: '#888', marginBottom: '4px' }}>
                      Next Snapshot In
                    </div>
                    <div style={{ fontSize: '1.5rem', fontWeight: '700', fontFamily: 'monospace' }}>
                      {formatTimeRemaining(timeRemaining)}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: '0.75rem', color: '#888', marginBottom: '4px' }}>
                      Last Updated
                    </div>
                    <div style={{ fontSize: '0.9rem' }}>
                      {lastSnapshot ? lastSnapshot.toLocaleString() : 'Never'}
                    </div>
                  </div>
                  <button
                    onClick={loadSnapshot}
                    disabled={loading || !canFetchFromMoralis(selectedToken)}
                    style={{
                      padding: '10px 20px',
                      background: loading ? 'rgba(255,255,255,0.1)' : 'linear-gradient(135deg, #7b2ff7 0%, #f107a3 100%)',
                      border: 'none',
                      borderRadius: '8px',
                      color: '#fff',
                      fontSize: '0.85rem',
                      fontWeight: '600',
                      cursor: loading ? 'not-allowed' : 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      opacity: canFetchFromMoralis(selectedToken) ? 1 : 0.5
                    }}
                  >
                    {loading ? <LoadingSpinner size={16} /> : '🔄'}
                    {loading ? 'Loading...' : 'Refresh Now'}
                  </button>
                </div>

                {/* Error Display */}
                {error && (
                  <div style={{
                    background: 'rgba(239, 68, 68, 0.1)',
                    border: '1px solid rgba(239, 68, 68, 0.3)',
                    borderRadius: '12px',
                    padding: '16px',
                    marginBottom: '24px',
                    color: '#ef4444'
                  }}>
                    ⚠️ {error}
                  </div>
                )}

                {/* Phase 4: Social Links */}
                {tokenInfo?.links && (
                  <SocialLinks links={tokenInfo.links} />
                )}

                {/* Phase 4: Price Chart */}
                {selectedToken?.coingeckoId && (
                  <PriceChart 
                    data={priceHistory} 
                    timeframe={priceTimeframe} 
                    setTimeframe={setPriceTimeframe} 
                  />
                )}

                {/* Phase 4: Token Metrics */}
                {canFetchFromMoralis(selectedToken) && (
                  <TokenMetricsCard 
                    tokenInfo={tokenInfo} 
                    holders={holders}
                    poolsData={poolsData}
                  />
                )}

                {/* Phase 4: Holder Distribution Chart */}
                {holders.length > 0 && (
                  <HolderDistributionChart holders={holders} />
                )}

                {/* Phase 4: Liquidity & Activity */}
                {poolsData.length > 0 && (
                  <PoolsTable pools={poolsData} />
                )}

                {/* Tabs */}
                {canFetchFromMoralis(selectedToken) && (
                  <div style={{
                    display: 'flex',
                    gap: '8px',
                    marginBottom: '16px'
                  }}>
                    <button
                      onClick={() => setActiveTab('holders')}
                      style={{
                        padding: '12px 24px',
                        background: activeTab === 'holders' 
                          ? 'linear-gradient(135deg, #7b2ff7 0%, #f107a3 100%)'
                          : 'rgba(255,255,255,0.05)',
                        border: 'none',
                        borderRadius: '10px',
                        color: '#fff',
                        fontSize: '0.9rem',
                        fontWeight: '600',
                        cursor: 'pointer'
                      }}
                    >
                      🐋 Top Holders ({holders.length})
                    </button>
                    <button
                      onClick={() => setActiveTab('transfers')}
                      style={{
                        padding: '12px 24px',
                        background: activeTab === 'transfers' 
                          ? 'linear-gradient(135deg, #7b2ff7 0%, #f107a3 100%)'
                          : 'rgba(255,255,255,0.05)',
                        border: 'none',
                        borderRadius: '10px',
                        color: '#fff',
                        fontSize: '0.9rem',
                        fontWeight: '600',
                        cursor: 'pointer'
                      }}
                    >
                      💰 Recent Transactions ({processedTransfers.length})
                    </button>
                  </div>
                )}

                {/* Loading State */}
                {loading && (
                  <div style={{
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: 'center',
                    padding: '60px',
                    background: 'rgba(255,255,255,0.02)',
                    borderRadius: '16px'
                  }}>
                    <LoadingSpinner size={32} />
                    <span style={{ marginLeft: '16px', color: '#888' }}>Loading data...</span>
                  </div>
                )}

                {/* Holders Table */}
                {!loading && activeTab === 'holders' && holders.length > 0 && (
                  <div style={{
                    background: 'rgba(255,255,255,0.02)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: '16px',
                    overflow: 'hidden'
                  }}>
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                        <thead>
                          <tr style={{ 
                            background: 'rgba(255,255,255,0.05)',
                            borderBottom: '1px solid rgba(255,255,255,0.1)'
                          }}>
                            <th style={{ padding: '16px', textAlign: 'left', color: '#888', fontWeight: '600', fontSize: '0.75rem' }}>#</th>
                            <th style={{ padding: '16px', textAlign: 'left', color: '#888', fontWeight: '600', fontSize: '0.75rem' }}>WALLET</th>
                            <th style={{ padding: '16px', textAlign: 'left', color: '#888', fontWeight: '600', fontSize: '0.75rem', cursor: 'pointer' }} onClick={() => handleSort('balance')}>
                              BALANCE <SortIcon column="balance" />
                            </th>
                            <th style={{ padding: '16px', textAlign: 'left', color: '#888', fontWeight: '600', fontSize: '0.75rem', cursor: 'pointer' }} onClick={() => handleSort('usd')}>
                              USD VALUE <SortIcon column="usd" />
                            </th>
                            <th style={{ padding: '16px', textAlign: 'left', color: '#888', fontWeight: '600', fontSize: '0.75rem', cursor: 'pointer' }} onClick={() => handleSort('percentage')}>
                              % SUPPLY <SortIcon column="percentage" />
                            </th>
                            <th style={{ padding: '16px', textAlign: 'left', color: '#888', fontWeight: '600', fontSize: '0.75rem' }}>TYPE</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sortedHolders.map((holder, idx) => {
                            const balance = parseFloat(holder.balance_formatted || holder.balance) || 0;
                            const usdValue = balance * tokenPrice;
                            const pct = parseFloat(holder.percentage_relative_to_total_supply || 0);
                            const globalIdx = idx;
                            
                            // Check for badges
                            const isNew = snapshotComparison.newWhales.includes(holder.owner_address);
                            const change = snapshotComparison.changes[holder.owner_address];
                            const badges = [];
                            
                            if (isNew) {
                              badges.push({ text: '🆕 NEW', bg: 'rgba(16, 185, 129, 0.2)', color: '#10b981' });
                            }
                            if (change && Math.abs(change.changePercent) >= WHALE_CHANGE_THRESHOLD) {
                              if (change.changePercent > 0) {
                                badges.push({ text: `📈 +${change.changePercent.toFixed(1)}%`, bg: 'rgba(16, 185, 129, 0.2)', color: '#10b981' });
                              } else {
                                badges.push({ text: `📉 ${change.changePercent.toFixed(1)}%`, bg: 'rgba(239, 68, 68, 0.2)', color: '#ef4444' });
                              }
                            }
                            
                            return (
                              <tr 
                                key={holder.owner_address}
                                style={{
                                  borderBottom: '1px solid rgba(255,255,255,0.05)',
                                  transition: 'background 0.2s ease'
                                }}
                                onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
                                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                              >
                                <td style={{ padding: '14px 16px' }}>
                                  <span style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    width: '28px',
                                    height: '28px',
                                    background: globalIdx < 3 
                                      ? 'linear-gradient(135deg, #ffd700 0%, #ff8c00 100%)'
                                      : globalIdx < 10 
                                      ? 'linear-gradient(135deg, #7b2ff7 0%, #f107a3 100%)'
                                      : 'rgba(255,255,255,0.1)',
                                    borderRadius: '6px',
                                    fontSize: '0.75rem',
                                    fontWeight: '700',
                                    color: globalIdx < 10 ? '#fff' : '#888'
                                  }}>
                                    {globalIdx + 1}
                                  </span>
                                </td>
                                <td style={{ padding: '14px 16px' }}>
                                  <AddressDisplay 
                                    address={holder.owner_address} 
                                    chain={selectedToken.chain}
                                    badges={badges}
                                    onClick={(addr) => setSelectedWallet(addr)}
                                  />
                                </td>
                                <td style={{ padding: '14px 16px' }}>
                                  <span style={{ fontWeight: '600' }}>{formatNumber(balance)}</span>
                                  <span style={{ color: '#666', marginLeft: '4px' }}>
                                    {tokenInfo?.symbol || selectedToken.symbol}
                                  </span>
                                </td>
                                <td style={{ padding: '14px 16px' }}>
                                  <span style={{ color: '#10b981', fontWeight: '600' }}>
                                    {formatUSD(usdValue)}
                                  </span>
                                </td>
                                <td style={{ padding: '14px 16px' }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                    <div style={{
                                      width: '60px',
                                      height: '6px',
                                      background: 'rgba(255,255,255,0.1)',
                                      borderRadius: '3px',
                                      overflow: 'hidden'
                                    }}>
                                      <div style={{
                                        width: `${Math.min(pct * 3, 100)}%`,
                                        height: '100%',
                                        background: 'linear-gradient(90deg, #7b2ff7, #f107a3)',
                                        borderRadius: '3px'
                                      }} />
                                    </div>
                                    <span style={{ color: '#888', fontSize: '0.8rem' }}>
                                      {pct.toFixed(2)}%
                                    </span>
                                  </div>
                                </td>
                                <td style={{ padding: '14px 16px' }}>
                                  {change ? (
                                    <span style={{
                                      color: change.changePercent > 0 ? '#10b981' : '#ef4444',
                                      fontWeight: '600',
                                      fontSize: '0.8rem'
                                    }}>
                                      {change.changePercent > 0 ? '+' : ''}{change.changePercent.toFixed(2)}%
                                    </span>
                                  ) : isNew ? (
                                    <span style={{ color: '#10b981', fontSize: '0.8rem' }}>New</span>
                                  ) : (
                                    <span style={{ color: '#666', fontSize: '0.8rem' }}>—</span>
                                  )}
                                </td>
                                <td style={{ padding: '14px 16px' }}>
                                  <span style={{
                                    background: holder.is_contract 
                                      ? 'rgba(255, 159, 64, 0.2)'
                                      : 'rgba(0, 212, 255, 0.2)',
                                    color: holder.is_contract ? '#f59e0b' : '#00d4ff',
                                    padding: '4px 10px',
                                    borderRadius: '6px',
                                    fontSize: '0.7rem',
                                    fontWeight: '600',
                                    textTransform: 'uppercase'
                                  }}>
                                    {holder.is_contract ? '📜 Contract' : '👤 Wallet'}
                                  </span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    
                    {/* Holder Pagination */}
                    {sortedHolders.length > TOKENS_PER_PAGE && (
                      <Pagination 
                        currentPage={holderPage}
                        totalPages={Math.ceil(sortedHolders.length / TOKENS_PER_PAGE)}
                        onPageChange={setHolderPage}
                      />
                    )}
                    
                    {loadingMore && (
                      <div style={{ 
                        textAlign: 'center', 
                        padding: '12px',
                        color: '#888',
                        fontSize: '0.8rem'
                      }}>
                        <LoadingSpinner size={16} /> Loading more holders...
                      </div>
                    )}
                  </div>
                )}

                {/* Transactions Table */}
                {!loading && activeTab === 'transfers' && (
                  <div style={{
                    background: 'rgba(255,255,255,0.02)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: '16px',
                    overflow: 'hidden'
                  }}>
                    <TransactionFilters 
                      minAmount={txMinAmount}
                      setMinAmount={setTxMinAmount}
                      txType={txType}
                      setTxType={setTxType}
                    />
                    
                    {processedTransfers.length === 0 ? (
                      <div style={{ 
                        padding: '40px', 
                        textAlign: 'center',
                        color: '#888'
                      }}>
                        No transactions found with current filters
                      </div>
                    ) : (
                      <>
                        <div style={{ overflowX: 'auto' }}>
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                            <thead>
                              <tr style={{ 
                                background: 'rgba(255,255,255,0.05)',
                                borderBottom: '1px solid rgba(255,255,255,0.1)'
                              }}>
                                <th style={{ padding: '16px', textAlign: 'left', color: '#888', fontWeight: '600', fontSize: '0.75rem' }}>#</th>
                                <th style={{ padding: '16px', textAlign: 'left', color: '#888', fontWeight: '600', fontSize: '0.75rem' }}>TYPE</th>
                                <th style={{ padding: '16px', textAlign: 'left', color: '#888', fontWeight: '600', fontSize: '0.75rem' }}>WALLET</th>
                                <th style={{ padding: '16px', textAlign: 'left', color: '#888', fontWeight: '600', fontSize: '0.75rem' }}>DETAILS</th>
                                <th style={{ padding: '16px', textAlign: 'left', color: '#888', fontWeight: '600', fontSize: '0.75rem' }}>AMOUNT</th>
                                <th style={{ padding: '16px', textAlign: 'left', color: '#888', fontWeight: '600', fontSize: '0.75rem' }}>USD VALUE</th>
                                <th style={{ padding: '16px', textAlign: 'left', color: '#888', fontWeight: '600', fontSize: '0.75rem' }}>TIME</th>
                              </tr>
                            </thead>
                            <tbody>
                              {paginatedTransfers.map((transfer, idx) => {
                                const globalIdx = (txPage - 1) * TRANSACTIONS_PER_PAGE + idx;
                                
                                return (
                                  <tr 
                                    key={`${transfer.transaction_hash}-${idx}`}
                                    style={{
                                      borderBottom: '1px solid rgba(255,255,255,0.05)',
                                      transition: 'background 0.2s ease'
                                    }}
                                    onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
                                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                                  >
                                    <td style={{ padding: '14px 16px' }}>
                                      <span style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        width: '28px',
                                        height: '28px',
                                        background: transfer.usdValue > 100000 
                                          ? 'linear-gradient(135deg, #ffd700 0%, #ff8c00 100%)'
                                          : 'rgba(255,255,255,0.1)',
                                        borderRadius: '6px',
                                        fontSize: '0.75rem',
                                        fontWeight: '700',
                                        color: transfer.usdValue > 100000 ? '#000' : '#888'
                                      }}>
                                        {globalIdx + 1}
                                      </span>
                                    </td>
                                    <td style={{ padding: '14px 16px' }}>
                                      <span style={{
                                        background: transfer.type === 'buy' 
                                          ? 'rgba(16, 185, 129, 0.2)'
                                          : transfer.type === 'sell'
                                          ? 'rgba(239, 68, 68, 0.2)'
                                          : 'rgba(0, 212, 255, 0.2)',
                                        color: transfer.type === 'buy' 
                                          ? '#10b981'
                                          : transfer.type === 'sell'
                                          ? '#ef4444'
                                          : '#00d4ff',
                                        padding: '4px 10px',
                                        borderRadius: '6px',
                                        fontSize: '0.7rem',
                                        fontWeight: '600',
                                        textTransform: 'uppercase'
                                      }}>
                                        {transfer.type === 'buy' ? '🟢 Buy' : 
                                         transfer.type === 'sell' ? '🔴 Sell' : '↔️ Transfer'}
                                      </span>
                                    </td>
                                    <td style={{ padding: '14px 16px' }}>
                                      {(transfer.trader_address || transfer.from_address) ? (
                                        <AddressDisplay 
                                          address={transfer.trader_address || transfer.from_address} 
                                          chain={selectedToken.chain}
                                          color="#00d4ff"
                                        />
                                      ) : (
                                        <span style={{ color: '#666' }}>-</span>
                                      )}
                                    </td>
                                    <td style={{ padding: '14px 16px' }}>
                                      {transfer.type === 'buy' || transfer.type === 'sell' ? (
                                        <span style={{ 
                                          color: '#888', 
                                          fontSize: '0.75rem',
                                          maxWidth: '150px',
                                          overflow: 'hidden',
                                          textOverflow: 'ellipsis',
                                          whiteSpace: 'nowrap',
                                          display: 'block'
                                        }}>
                                          {transfer.pool_name || 'DEX Swap'}
                                        </span>
                                      ) : transfer.to_address ? (
                                        <span style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.75rem' }}>
                                          <span style={{ color: '#666' }}>→</span>
                                          <AddressDisplay 
                                            address={transfer.to_address} 
                                            chain={selectedToken.chain}
                                            color="#10b981"
                                          />
                                        </span>
                                      ) : (
                                        <span style={{ color: '#666', fontSize: '0.75rem' }}>-</span>
                                      )}
                                    </td>
                                    <td style={{ padding: '14px 16px' }}>
                                      <span style={{ fontWeight: '600' }}>{formatNumber(transfer.amount)}</span>
                                      <span style={{ color: '#666', marginLeft: '4px' }}>
                                        {tokenInfo?.symbol || selectedToken.symbol}
                                      </span>
                                    </td>
                                    <td style={{ padding: '14px 16px' }}>
                                      <span style={{ 
                                        color: transfer.usdValue > 100000 ? '#ffd700' : 
                                               transfer.usdValue > 10000 ? '#10b981' : '#888', 
                                        fontWeight: '700'
                                      }}>
                                        {formatUSD(transfer.usdValue)}
                                        {transfer.usdValue > 100000 && ' 🔥'}
                                        {transfer.usdValue > 500000 && '🔥'}
                                        {transfer.usdValue > 1000000 && '🔥'}
                                      </span>
                                    </td>
                                    <td style={{ padding: '14px 16px' }}>
                                      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                                        <a 
                                          href={`${network.explorer}/tx/${transfer.transaction_hash}`}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          style={{ color: '#888', fontSize: '0.8rem', textDecoration: 'none' }}
                                        >
                                          {transfer.block_timestamp 
                                            ? formatTimeAgo(transfer.block_timestamp)
                                            : 'Recent'
                                          }
                                        </a>
                                        <span style={{ 
                                          fontSize: '0.6rem', 
                                          color: transfer.source === 'geckoterminal' ? '#10b981' : '#00d4ff',
                                          opacity: 0.7
                                        }}>
                                          {transfer.source === 'geckoterminal' ? 'DEX' : 'Chain'}
                                        </span>
                                      </div>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                        
                        {/* Transaction Pagination */}
                        {processedTransfers.length > TRANSACTIONS_PER_PAGE && (
                          <Pagination 
                            currentPage={txPage}
                            totalPages={Math.ceil(processedTransfers.length / TRANSACTIONS_PER_PAGE)}
                            onPageChange={setTxPage}
                          />
                        )}
                      </>
                    )}
                  </div>
                )}
              </>
            )}
          </>
        )}

        {/* Wallet Tracker View */}
        {activeView === 'wallets' && (
          <WalletTrackerView 
            onSelectWallet={(addr, chain) => {
              setSelectedWallet(addr);
              setWalletViewChain(chain);
            }}
          />
        )}

        {/* Footer */}
        <div style={{
          textAlign: 'center',
          padding: '48px 20px 24px',
          color: THEME.text.muted,
          fontSize: '0.75rem',
          borderTop: `1px solid ${THEME.border.default}`,
          marginTop: '48px'
        }}>
          <p>Data: CoinGecko • Moralis • GeckoTerminal</p>
          <p style={{ marginTop: '6px', color: THEME.text.secondary }}>
            {tokens.length > 0 ? `${tokens.length} tokens tracked` : ''} • {Object.keys(NETWORKS).length} networks
          </p>
        </div>

        {/* Wallet Profiler Modal */}
        {selectedWallet && (
          <WalletProfiler
            wallet={selectedWallet}
            walletData={walletData}
            loading={walletLoading}
            onClose={() => setSelectedWallet(null)}
            chain={selectedToken?.chain || walletViewChain}
          />
        )}
      </div>
    </div>
  );
}
