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
  let networkKey = 'eth';
  if (token.platforms) {
    for (const [platform, address] of Object.entries(token.platforms)) {
      if (address && COINGECKO_PLATFORM_MAP[platform]) {
        networkKey = COINGECKO_PLATFORM_MAP[platform];
        break;
      }
    }
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
        <NetworkBadge chain={networkKey} small />
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
  const [error, setError] = useState(null);
  const [lastSnapshot, setLastSnapshot] = useState(null);
  const [timeRemaining, setTimeRemaining] = useState(SNAPSHOT_INTERVAL);
  const [sortConfig, setSortConfig] = useState({ key: 'balance', direction: 'desc' });
  const [activeTab, setActiveTab] = useState('holders');
  
  // Pagination state
  const [holderPage, setHolderPage] = useState(1);
  const [txPage, setTxPage] = useState(1);

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

  // Fetch recent transfers
  const fetchTransfers = useCallback(async () => {
    if (!selectedToken || !canFetchFromMoralis(selectedToken)) return [];
    
    if (selectedToken.chain === 'solana') {
      try {
        const data = await fetchFromAPI(
          `/token/mainnet/${selectedToken.address}/swaps?limit=50`,
          'solana'
        );
        return (data?.result || data || []).map(t => ({
          from_address: t.walletAddress || t.from_address,
          to_address: t.walletAddress || t.to_address,
          value: t.amount || t.value,
          transaction_hash: t.transactionHash || t.transaction_hash,
          block_timestamp: t.blockTimestamp || t.block_timestamp,
          token_decimals: t.tokenDecimals || 9
        }));
      } catch (err) {
        console.error('Solana transfers fetch error:', err);
        return [];
      }
    }
    
    try {
      const data = await fetchFromAPI(
        `/erc20/${selectedToken.address}/transfers?chain=${selectedToken.chain}&limit=50&order=DESC`
      );
      return data.result || [];
    } catch (err) {
      console.error('Transfers fetch error:', err);
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

  // Process transfers
  const processedTransfers = React.useMemo(() => {
    return transfers.map(t => {
      const decimals = parseInt(t.token_decimals || tokenInfo?.decimals || 18);
      const amount = parseFloat(t.value) / Math.pow(10, decimals);
      const usdValue = amount * tokenPrice;
      return {
        ...t,
        amount,
        usdValue,
        type: t.from_address === '0x0000000000000000000000000000000000000000' ? 'mint' : 
              t.to_address === '0x0000000000000000000000000000000000000000' ? 'burn' : 'transfer'
      };
    }).sort((a, b) => b.usdValue - a.usdValue);
  }, [transfers, tokenPrice, tokenInfo]);

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
                      📜 Recent Transfers ({transfers.length})
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
                                        background: transfer.type === 'mint' 
                                          ? 'rgba(16, 185, 129, 0.2)'
                                          : transfer.type === 'burn'
                                          ? 'rgba(239, 68, 68, 0.2)'
                                          : 'rgba(0, 212, 255, 0.2)',
                                        color: transfer.type === 'mint' 
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
                                        {transfer.type === 'mint' ? '🌱 Mint' : 
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
