import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';

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

// Supported networks (Optimism removed)
const NETWORKS = {
  eth: { 
    name: 'Ethereum', 
    explorer: 'https://etherscan.io',
    color: '#627eea',
    coingeckoId: 'ethereum'
  },
  arbitrum: { 
    name: 'Arbitrum', 
    explorer: 'https://arbiscan.io',
    color: '#28a0f0',
    coingeckoId: 'arbitrum-one'
  },
  base: { 
    name: 'Base', 
    explorer: 'https://basescan.org',
    color: '#0052ff',
    coingeckoId: 'base'
  },
  polygon: { 
    name: 'Polygon', 
    explorer: 'https://polygonscan.com',
    color: '#8247e5',
    coingeckoId: 'polygon-pos'
  },
  bsc: { 
    name: 'BNB Chain', 
    explorer: 'https://bscscan.com',
    color: '#f0b90b',
    coingeckoId: 'binance-smart-chain'
  },
  solana: {
    name: 'Solana',
    explorer: 'https://solscan.io',
    color: '#9945ff',
    coingeckoId: 'solana'
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

const AddressDisplay = ({ address, chain, label, color = '#00d4ff', badges = [] }) => {
  const network = NETWORKS[chain] || NETWORKS.eth;
  const addressPath = chain === 'solana' ? '/account/' : '/address/';
  
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
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
      } else {
        throw new Error('Failed to fetch market data');
      }
    } catch (err) {
      console.error('Market data error:', err);
      setError('Failed to load market data. CoinGecko API may be rate limited.');
    } finally {
      setLoading(false);
    }
  }, []);

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
        marginBottom: '16px',
        flexWrap: 'wrap',
        gap: '12px'
      }}>
        <h2 style={{
          fontSize: '1.5rem',
          fontWeight: '700',
          margin: 0,
          display: 'flex',
          alignItems: 'center',
          gap: '10px'
        }}>
          📊 Market Overview
        </h2>
        <div style={{ fontSize: '0.75rem', color: '#888' }}>
          Data from CoinGecko • Top 100 tokens • Updates every 5 min
        </div>
      </div>

      {/* Market Tabs */}
      <div style={{
        display: 'flex',
        gap: '8px',
        marginBottom: '16px',
        borderBottom: '1px solid rgba(255,255,255,0.1)',
        paddingBottom: '12px',
        flexWrap: 'wrap'
      }}>
        {[
          { id: 'gainers', label: '📈 Top Gainers' },
          { id: 'losers', label: '📉 Top Losers' },
          { id: 'volume', label: '📊 Top Volume' }
        ].map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveMarketTab(tab.id)}
            style={{
              padding: '10px 20px',
              background: activeMarketTab === tab.id 
                ? 'linear-gradient(135deg, #7b2ff7 0%, #f107a3 100%)'
                : 'rgba(255,255,255,0.05)',
              border: 'none',
              borderRadius: '8px',
              color: '#fff',
              fontSize: '0.85rem',
              fontWeight: '600',
              cursor: 'pointer'
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
          background: 'rgba(255,255,255,0.02)',
          borderRadius: '12px'
        }}>
          <LoadingSpinner size={32} />
          <span style={{ marginLeft: '12px', color: '#888' }}>Loading market data...</span>
        </div>
      ) : error ? (
        <div style={{
          padding: '40px',
          textAlign: 'center',
          background: 'rgba(239, 68, 68, 0.1)',
          borderRadius: '12px',
          color: '#ef4444'
        }}>
          {error}
          <button
            onClick={fetchMarketData}
            style={{
              display: 'block',
              margin: '16px auto 0',
              padding: '8px 16px',
              background: 'rgba(255,255,255,0.1)',
              border: 'none',
              borderRadius: '6px',
              color: '#fff',
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
            background: 'rgba(255,255,255,0.02)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '12px',
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
  const [searchChain, setSearchChain] = useState('eth');
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
        // Direct contract address
        onAddToken({
          address: searchQuery,
          symbol: 'CUSTOM',
          name: 'Custom Token',
          chain: searchChain,
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
          
          // Find contract address for selected chain or first available
          let contractAddress = null;
          let actualChain = searchChain;
          
          if (data.platforms) {
            // First try selected chain
            const selectedPlatform = Object.entries(COINGECKO_PLATFORM_MAP)
              .find(([_, v]) => v === searchChain)?.[0];
            
            if (selectedPlatform && data.platforms[selectedPlatform]) {
              contractAddress = data.platforms[selectedPlatform];
            } else {
              // Find first available
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
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: '12px',
        padding: '16px',
        marginBottom: '16px',
        position: 'relative'
      }}>
        <div style={{ 
          fontSize: '0.75rem', 
          color: '#888', 
          marginBottom: '12px',
          textTransform: 'uppercase',
          letterSpacing: '1px'
        }}>
          🔍 Search by token ticker, name, or contract address
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
                padding: '12px 16px',
                background: 'rgba(0,0,0,0.3)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '8px',
                color: '#fff',
                fontSize: '0.9rem'
              }}
            />
            
            {/* Search Results Dropdown */}
            {showResults && (
              <div style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                right: 0,
                background: '#1a1a2e',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '8px',
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
                      padding: '12px 16px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '12px',
                      cursor: 'pointer',
                      borderBottom: '1px solid rgba(255,255,255,0.05)',
                      transition: 'background 0.2s'
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.05)'}
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
                      <div style={{ fontWeight: '600', textTransform: 'uppercase' }}>
                        {result.symbol}
                      </div>
                      <div style={{ fontSize: '0.75rem', color: '#888' }}>
                        {result.name}
                      </div>
                    </div>
                    {result.market_cap_rank && (
                      <span style={{ 
                        marginLeft: 'auto', 
                        fontSize: '0.7rem', 
                        color: '#666' 
                      }}>
                        #{result.market_cap_rank}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          
          <div style={{ minWidth: '150px' }}>
            <select
              value={searchChain}
              onChange={(e) => setSearchChain(e.target.value)}
              style={{
                width: '100%',
                padding: '12px 16px',
                background: 'rgba(0,0,0,0.3)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '8px',
                color: '#fff',
                fontSize: '0.9rem',
                cursor: 'pointer'
              }}
            >
              {Object.entries(NETWORKS).map(([key, network]) => (
                <option key={key} value={key}>{network.name}</option>
              ))}
            </select>
          </div>
          
          {searching && (
            <LoadingSpinner size={20} />
          )}
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
    return token?.hasContractAddress && token?.address?.startsWith('0x');
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

  // Fetch token metadata
  const fetchTokenInfo = useCallback(async () => {
    if (!selectedToken || !canFetchFromMoralis(selectedToken)) return null;
    
    if (selectedToken.chain === 'solana') {
      try {
        const data = await fetchFromAPI(
          `/token/mainnet/${selectedToken.address}/metadata`,
          'solana'
        );
        return data || null;
      } catch (err) {
        console.error('Solana token info fetch error:', err);
        return null;
      }
    }
    
    try {
      const data = await fetchFromAPI(
        `/erc20/metadata?chain=${selectedToken.chain}&addresses[]=${selectedToken.address}`
      );
      return data[0] || null;
    } catch (err) {
      console.error('Token info fetch error:', err);
      return null;
    }
  }, [selectedToken]);

  // Fetch token price
  const fetchTokenPrice = useCallback(async () => {
    if (!selectedToken || !canFetchFromMoralis(selectedToken)) return 0;
    
    if (selectedToken.chain === 'solana') {
      try {
        const data = await fetchFromAPI(
          `/token/mainnet/${selectedToken.address}/price`,
          'solana'
        );
        return data?.usdPrice || 0;
      } catch (err) {
        console.error('Solana price fetch error:', err);
        return 0;
      }
    }
    
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
    
    if (selectedToken.chain === 'solana') {
      try {
        const data = await fetchFromAPI(
          `/token/mainnet/${selectedToken.address}/holders?limit=100`,
          'solana'
        );
        return (data?.result || data || []).map(h => ({
          owner_address: h.ownerAddress || h.owner_address,
          balance: h.amount || h.balance,
          balance_formatted: h.amountFormatted || h.balance_formatted,
          percentage_relative_to_total_supply: h.percentageOfSupply || h.percentage_relative_to_total_supply,
          is_contract: false
        }));
      } catch (err) {
        console.error('Solana holders fetch error:', err);
        return [];
      }
    }
    
    try {
      const data = await fetchFromAPI(
        `/erc20/${selectedToken.address}/owners?chain=${selectedToken.chain}&limit=100&order=DESC`
      );
      return data.result || [];
    } catch (err) {
      console.error('Holders fetch error:', err);
      return [];
    }
  }, [selectedToken]);

  // Fetch recent transactions (transfers + swaps/trades)
  const fetchTransfers = useCallback(async () => {
    if (!selectedToken || !canFetchFromMoralis(selectedToken)) return [];
    
    if (selectedToken.chain === 'solana') {
      try {
        // For Solana, get both swaps and transfers
        const [swapsData, transfersData] = await Promise.all([
          fetchFromAPI(
            `/token/mainnet/${selectedToken.address}/swaps?limit=100`,
            'solana'
          ).catch(() => []),
          fetchFromAPI(
            `/token/mainnet/${selectedToken.address}/transfers?limit=100`,
            'solana'
          ).catch(() => [])
        ]);
        
        const swaps = (swapsData?.result || swapsData || []).map(t => ({
          from_address: t.walletAddress || t.from_address || '',
          to_address: t.walletAddress || t.to_address || '',
          value: t.amount || t.value || '0',
          transaction_hash: t.transactionHash || t.transaction_hash,
          block_timestamp: t.blockTimestamp || t.block_timestamp,
          token_decimals: t.tokenDecimals || 9,
          activity_type: 'swap',
          swap_type: t.type || 'swap',
          usd_value: t.usdAmount || t.usd_value || 0
        }));
        
        const transfers = (transfersData?.result || transfersData || []).map(t => ({
          from_address: t.from_address || t.fromAddress || '',
          to_address: t.to_address || t.toAddress || '',
          value: t.amount || t.value || '0',
          transaction_hash: t.transactionHash || t.transaction_hash,
          block_timestamp: t.blockTimestamp || t.block_timestamp,
          token_decimals: t.tokenDecimals || 9,
          activity_type: 'transfer'
        }));
        
        return [...swaps, ...transfers];
      } catch (err) {
        console.error('Solana transactions fetch error:', err);
        return [];
      }
    }
    
    try {
      // For EVM chains, fetch transfers (Moralis limit is 100 per request)
      const transfersData = await fetchFromAPI(
        `/erc20/${selectedToken.address}/transfers?chain=${selectedToken.chain}&limit=100`
      );
      
      if (!transfersData || !transfersData.result) {
        console.log('No transfers data returned');
        return [];
      }
      
      // Comprehensive list of DEX routers and aggregators across all chains
      const knownDexRouters = [
        // === UNISWAP ===
        '0x7a250d5630b4cf539739df2c5dacb4c659f2488d', // Uniswap V2 Router (Ethereum)
        '0xe592427a0aece92de3edee1f18e0157c05861564', // Uniswap V3 Router
        '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45', // Uniswap Universal Router
        '0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b', // Uniswap Universal Router 2
        '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad', // Uniswap Universal Router 3
        '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24', // Uniswap V2 Router (Base)
        '0x2626664c2603336e57b271c5c0b26f421741e481', // Uniswap V3 Router (Base)
        '0x4c60051384bd2d3c01bfc845cf5f4b44bcbe9de5', // Uniswap Universal Router (Arbitrum)
        '0xec7be89e9d109e7e3fec59c222cf297125fefda2', // Uniswap V3 (Arbitrum)
        
        // === 1INCH ===
        '0x1111111254eeb25477b68fb85ed929f73a960582', // 1inch V5 Router
        '0x1111111254fb6c44bac0bed2854e76f90643097d', // 1inch V4 Router
        '0x11111112542d85b3ef69ae05771c2dccff4faa26', // 1inch V3 Router
        '0x111111125434b319222cdbf8c261674adb56f3ae', // 1inch V2 Router
        '0x1111111254760f7ab3f16433eea9304126dcd199', // 1inch Aggregation Router V6
        '0x111111125421ca6dc452d289314280a0f8842a65', // 1inch Router (Multi-chain)
        
        // === 0x PROTOCOL ===
        '0xdef1c0ded9bec7f1a1670819833240f027b25eff', // 0x Exchange Proxy (Ethereum)
        '0xdef1abe32c034e558cdd535791643c58a13acc10', // 0x Exchange Proxy (Polygon)
        '0xdb6f1920a889355780af7570773609bd8cb1f498', // 0x Exchange Proxy (Arbitrum)
        
        // === SUSHISWAP ===
        '0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f', // SushiSwap Router (Ethereum)
        '0x1b02da8cb0d097eb8d57a175b88c7d8b47997506', // SushiSwap Router (Polygon/Arbitrum)
        '0x6baced43a3d8f36f9da05c097aba46da87fec60b', // SushiSwap Route Processor 3
        '0x544ba588efd839d2692fc31ea991cd39993c135f', // SushiSwap Route Processor 4
        '0x46b3fdf7b5cde91ac049936bf0bdb12c5d22202e', // SushiSwap Route Processor (Base)
        
        // === PANCAKESWAP ===
        '0x10ed43c718714eb63d5aa57b78b54704e256024e', // PancakeSwap V2 Router (BSC)
        '0x13f4ea83d0bd40e75c8222255bc855a974568dd4', // PancakeSwap V3 Router (BSC)
        '0xefd1c56da2d1e5e9aaecd63cfbf62a5fc8a7f64a', // PancakeSwap Smart Router
        '0x1b81d678ffb9c0263b24a97847620c99d213eb14', // PancakeSwap Router (Ethereum)
        
        // === CURVE ===
        '0x99a58482bd75cbab83b27ec03ca68ff489b5788f', // Curve Router
        '0xf0d4c12a5768d806021f80a262b4d39d26c58b8d', // Curve Router V2
        '0x16c6521dff6bab339122a0fe25a9116693265353', // Curve Router NG
        
        // === BALANCER ===
        '0xba12222222228d8ba445958a75a0704d566bf2c8', // Balancer Vault (Multi-chain)
        
        // === KYBERSWAP ===
        '0x6131b5fae19ea4f9d964eac0408e4408b66337b5', // KyberSwap Router (Ethereum)
        '0xdf1a1b60f2d438842916c0adc43748768353ec25', // KyberSwap Aggregator
        '0x617dee16b86534a5d792a4d7a62fb491b544111e', // KyberSwap Meta Aggregator
        
        // === PARASWAP ===
        '0xdef171fe48cf0115b1d80b88dc8eab59176fee57', // Paraswap V5 Augustus
        '0x216b4b4ba9f3e719726886d34a177484278bfcae', // Paraswap V4
        '0x59c6c6f91f9ec0c67bea47ae71f552b2e13e2573', // Paraswap (Polygon)
        
        // === COWSWAP / GNOSIS ===
        '0x9008d19f58aabd9ed0d60971565aa8510560ab41', // Cowswap Settlement
        
        // === DODO ===
        '0xa356867fdcea8e71aeaf87805808803806231fdc', // DODO Router
        '0xa2398842f37465f89540430bdc00219fa9e4d28a', // DODO V2 Proxy
        '0x6d310348d5c12009854dff6c78dcdf87debb0a28', // DODO Route Proxy
        
        // === ODOS ===
        '0xcf5540fffcdc3d510b18bfca6d2b9987b0772559', // Odos Router V2
        '0x19ceead7105607cd444f5ad10dd51356436095a1', // Odos Router
        '0xa669e7a0d4b3e4fa48af2de86bd4cd7126be4e13', // Odos Router (Arbitrum)
        
        // === OPENOCEAN ===
        '0x6352a56caadc4f1e25cd6c75970fa768a3304e64', // OpenOcean Exchange
        
        // === METAMASK SWAP ===
        '0x881d40237659c251811cec9c364ef91dc08d300c', // MetaMask Swap Router
        
        // === LIFI ===
        '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae', // LiFi Diamond
        
        // === SOCKET / BUNGEE ===
        '0x3a23f943181408eac424116af7b7790c94cb97a5', // Socket Gateway
        
        // === HASHFLOW ===
        '0xe2a1163f01ee29e83cbb79d7a2edbe5a114f74ff', // Hashflow Router
        
        // === WOOFI ===
        '0x9503e7517d3c5bc4f9e4a1c6ae4f8b33ac2546f2', // WooFi Router
        
        // === TRADERJOE ===
        '0x60ae616a2155ee3d9a68541ba4544862310933d4', // TraderJoe Router (Avalanche)
        '0xb4315e873dbcf96ffd0acd8ea43f689d8c20fb30', // TraderJoe LB Router (Arbitrum)
        
        // === CAMELOT ===
        '0xc873fecbd354f5a56e00e710b90ef4201db2448d', // Camelot Router (Arbitrum)
        
        // === GMX ===
        '0xabd5a87087f16f6eb7a4a52e9b2dcfd3fb89678f', // GMX Router (Arbitrum)
        
        // === AERODROME (BASE) ===
        '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43', // Aerodrome Router
        '0x827922686190790b37229fd06084350e74485b72', // Aerodrome V2 Router
        
        // === VELODROME (OPTIMISM) ===
        '0xa062ae8a9c5e11aaa026fc2670b0d65ccc8b2858', // Velodrome V2 Router
        
        // === MAVERICK ===
        '0x32ae1a07f7bddd0e3467af8a95a7f1b5c0f0f0c6', // Maverick Router
        
        // === BASESWAP ===
        '0x327df1e6de05895d2ab08513aadd9313fe505d86', // BaseSwap Router
        
        // === ALIEN BASE ===
        '0x8c1a3cf8f83074169fe5d7ad50b978e1cd6b37c7', // AlienBase Router
      ].map(a => a.toLowerCase());
      
      const transactions = (transfersData.result || []).map(t => {
        const fromLower = (t.from_address || '').toLowerCase();
        const toLower = (t.to_address || '').toLowerCase();
        
        // Check if this is likely a swap (involves a DEX router)
        const isFromDex = knownDexRouters.includes(fromLower);
        const isToDex = knownDexRouters.includes(toLower);
        const isSwap = isFromDex || isToDex;
        
        let activityType = 'transfer';
        let swapType = null;
        
        if (isSwap) {
          activityType = 'swap';
          // If from DEX, user is buying (receiving tokens)
          // If to DEX, user is selling (sending tokens to DEX)
          swapType = isFromDex ? 'buy' : 'sell';
        } else if (fromLower === '0x0000000000000000000000000000000000000000') {
          activityType = 'mint';
        } else if (toLower === '0x0000000000000000000000000000000000000000') {
          activityType = 'burn';
        }
        
        return {
          ...t,
          activity_type: activityType,
          swap_type: swapType
        };
      });
      
      return transactions;
    } catch (err) {
      console.error('Transactions fetch error:', err);
      return [];
    }
  }, [selectedToken]);

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

  // Process transactions - calculate USD values and sort by largest
  const processedTransfers = React.useMemo(() => {
    if (!transfers || transfers.length === 0) return [];
    
    // First pass: calculate USD values for all transactions
    const withUsdValues = transfers.map(t => {
      const decimals = parseInt(t.token_decimals || tokenInfo?.decimals || 18);
      let amount = parseFloat(t.value || 0) / Math.pow(10, decimals);
      let usdValue = t.usd_value || (amount * tokenPrice);
      
      // Determine transaction type
      let type;
      if (t.activity_type === 'swap') {
        type = t.swap_type || 'swap';
      } else if (t.activity_type === 'mint') {
        type = 'mint';
      } else if (t.activity_type === 'burn') {
        type = 'burn';
      } else if (t.from_address === '0x0000000000000000000000000000000000000000') {
        type = 'mint';
      } else if (t.to_address === '0x0000000000000000000000000000000000000000') {
        type = 'burn';
      } else {
        type = 'transfer';
      }
      
      return {
        ...t,
        amount,
        usdValue,
        type
      };
    });
    
    // Sort by USD value (largest first)
    const sortedByValue = [...withUsdValues].sort((a, b) => b.usdValue - a.usdValue);
    
    // Apply filters
    let filtered = sortedByValue;
    
    // Apply minimum USD filter if set
    if (txMinAmount > 0) {
      filtered = filtered.filter(t => t.usdValue >= txMinAmount);
    } else {
      // Auto mode: show top 50 transactions or all if less than 50
      filtered = sortedByValue.slice(0, 100);
    }
    
    // Apply type filter
    if (txType !== 'all') {
      filtered = filtered.filter(t => t.type === txType);
    }
    
    return filtered;
  }, [transfers, tokenPrice, tokenInfo, txMinAmount, txType]);

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
      background: 'linear-gradient(135deg, #0a0a0f 0%, #1a1a2e 50%, #0f0f1a 100%)',
      color: '#e0e0e0',
      fontFamily: '"Inter", "SF Pro", -apple-system, sans-serif',
      padding: '20px'
    }}>
      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
      
      <div style={{ maxWidth: '1400px', margin: '0 auto' }}>
        
        {/* Header */}
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          flexWrap: 'wrap',
          gap: '20px',
          marginBottom: '24px'
        }}>
          <div>
            <h1 style={{
              fontSize: '2.5rem',
              fontWeight: '800',
              margin: '0 0 8px 0',
              background: 'linear-gradient(90deg, #00d4ff 0%, #7b2ff7 50%, #f107a3 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              letterSpacing: '-1px'
            }}>
              🧠 Smart Money Tracker
            </h1>
            <p style={{ margin: 0, color: '#888', fontSize: '0.9rem' }}>
              Track whale wallets across multiple tokens and networks
            </p>
          </div>
          
          {/* View Toggle */}
          <div style={{
            display: 'flex',
            background: 'rgba(255,255,255,0.05)',
            borderRadius: '12px',
            padding: '4px'
          }}>
            <button
              onClick={() => setActiveView('market')}
              style={{
                padding: '10px 20px',
                background: activeView === 'market' 
                  ? 'linear-gradient(135deg, #7b2ff7 0%, #f107a3 100%)'
                  : 'transparent',
                border: 'none',
                borderRadius: '8px',
                color: '#fff',
                fontSize: '0.85rem',
                fontWeight: '600',
                cursor: 'pointer'
              }}
            >
              📊 Market Overview
            </button>
            <button
              onClick={() => setActiveView('tracker')}
              style={{
                padding: '10px 20px',
                background: activeView === 'tracker' 
                  ? 'linear-gradient(135deg, #7b2ff7 0%, #f107a3 100%)'
                  : 'transparent',
                border: 'none',
                borderRadius: '8px',
                color: '#fff',
                fontSize: '0.85rem',
                fontWeight: '600',
                cursor: 'pointer'
              }}
            >
              🐋 Whale Tracker
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

        {/* Whale Tracker View */}
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

                {/* Stats Grid */}
                {canFetchFromMoralis(selectedToken) && (
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                    gap: '16px',
                    marginBottom: '24px'
                  }}>
                    <StatCard 
                      label="Token Price" 
                      value={formatUSD(tokenPrice)} 
                      icon="💰"
                      subValue={tokenInfo?.symbol || selectedToken.symbol}
                    />
                    <StatCard 
                      label="Market Cap" 
                      value={formatUSD(
                        tokenInfo?.total_supply 
                          ? (parseFloat(tokenInfo.total_supply) / Math.pow(10, parseInt(tokenInfo.decimals || 18))) * tokenPrice
                          : 0
                      )} 
                      icon="📊"
                    />
                    <StatCard 
                      label="Top Holders" 
                      value={holders.length} 
                      icon="🐋"
                      subValue={`Top 10%: ${top10PercentCount}`}
                    />
                    <StatCard 
                      label="Network" 
                      value={network.name} 
                      icon="🌐"
                    />
                  </div>
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
                                <th style={{ padding: '16px', textAlign: 'left', color: '#888', fontWeight: '600', fontSize: '0.75rem' }}>FROM</th>
                                <th style={{ padding: '16px', textAlign: 'left', color: '#888', fontWeight: '600', fontSize: '0.75rem' }}>TO</th>
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
                                          : transfer.type === 'mint'
                                          ? 'rgba(16, 185, 129, 0.2)'
                                          : transfer.type === 'burn'
                                          ? 'rgba(239, 68, 68, 0.2)'
                                          : 'rgba(0, 212, 255, 0.2)',
                                        color: transfer.type === 'buy' 
                                          ? '#10b981'
                                          : transfer.type === 'sell'
                                          ? '#ef4444'
                                          : transfer.type === 'mint'
                                          ? '#10b981'
                                          : transfer.type === 'burn'
                                          ? '#ef4444'
                                          : '#00d4ff',
                                        padding: '4px 10px',
                                        borderRadius: '6px',
                                        fontSize: '0.7rem',
                                        fontWeight: '600',
                                        textTransform: 'uppercase'
                                      }}>
                                        {transfer.type === 'buy' ? '🟢 Buy' : 
                                         transfer.type === 'sell' ? '🔴 Sell' :
                                         transfer.type === 'mint' ? '🌱 Mint' : 
                                         transfer.type === 'burn' ? '🔥 Burn' : '↔️ Transfer'}
                                      </span>
                                    </td>
                                    <td style={{ padding: '14px 16px' }}>
                                      <AddressDisplay 
                                        address={transfer.from_address} 
                                        chain={selectedToken.chain}
                                        color="#ef4444"
                                      />
                                    </td>
                                    <td style={{ padding: '14px 16px' }}>
                                      <AddressDisplay 
                                        address={transfer.to_address} 
                                        chain={selectedToken.chain}
                                        color="#10b981"
                                      />
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
                                      <a 
                                        href={`${network.explorer}/tx/${transfer.transaction_hash}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        style={{ color: '#888', fontSize: '0.8rem', textDecoration: 'none' }}
                                      >
                                        {transfer.block_timestamp 
                                          ? formatTimeAgo(transfer.block_timestamp)
                                          : `Block #${transfer.block_number}`
                                        }
                                      </a>
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

        {/* Footer */}
        <div style={{
          textAlign: 'center',
          padding: '40px 20px',
          color: '#666',
          fontSize: '0.8rem'
        }}>
          <p>Market data: CoinGecko • On-chain data: Moralis</p>
          <p style={{ marginTop: '8px' }}>
            {tokens.length > 0 ? `Tracking ${tokens.length} tokens` : 'No tokens tracked'} • {Object.keys(NETWORKS).length} networks supported
          </p>
          <p style={{ marginTop: '8px', color: '#555' }}>
            Phase 3: Enhanced Whale Tracking • Top 100 Holders • 7-Day Transaction History • Snapshot Comparison
          </p>
        </div>
      </div>
    </div>
  );
}
