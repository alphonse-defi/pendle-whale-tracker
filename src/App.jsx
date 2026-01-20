import React, { useState, useEffect, useCallback } from 'react';

// ============================================
// CONFIGURATION
// ============================================

const SNAPSHOT_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours in ms
const MARKET_REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes for market data

// Supported networks with their config (Optimism removed)
const NETWORKS = {
  eth: { 
    name: 'Ethereum', 
    explorer: 'https://etherscan.io',
    color: '#627eea',
    moralisChain: 'eth',
    coingeckoId: 'ethereum'
  },
  arbitrum: { 
    name: 'Arbitrum', 
    explorer: 'https://arbiscan.io',
    color: '#28a0f0',
    moralisChain: 'arbitrum',
    coingeckoId: 'arbitrum-one'
  },
  base: { 
    name: 'Base', 
    explorer: 'https://basescan.org',
    color: '#0052ff',
    moralisChain: 'base',
    coingeckoId: 'base'
  },
  polygon: { 
    name: 'Polygon', 
    explorer: 'https://polygonscan.com',
    color: '#8247e5',
    moralisChain: 'polygon',
    coingeckoId: 'polygon-pos'
  },
  bsc: { 
    name: 'BNB Chain', 
    explorer: 'https://bscscan.com',
    color: '#f0b90b',
    moralisChain: 'bsc',
    coingeckoId: 'binance-smart-chain'
  },
  solana: {
    name: 'Solana',
    explorer: 'https://solscan.io',
    color: '#9945ff',
    moralisChain: 'solana',
    coingeckoId: 'solana'
  }
};

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

const AddressDisplay = ({ address, chain, label, color = '#00d4ff' }) => {
  const network = NETWORKS[chain] || NETWORKS.eth;
  const addressPath = chain === 'solana' ? '/account/' : '/address/';
  
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
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
// TOKEN CARD COMPONENT (for market overview)
// ============================================

const TokenCard = ({ token, rank, onTrack, isTracked }) => {
  const priceChange = parseFloat(token.price_change_percentage_24h || 0) || 0;
  const isPositive = priceChange >= 0;
  
  return (
    <div style={{
      background: 'rgba(255,255,255,0.03)',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: '12px',
      padding: '16px',
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      transition: 'all 0.2s ease',
      cursor: 'pointer'
    }}
    onMouseEnter={e => {
      e.currentTarget.style.background = 'rgba(255,255,255,0.06)';
      e.currentTarget.style.borderColor = 'rgba(123, 47, 247, 0.3)';
    }}
    onMouseLeave={e => {
      e.currentTarget.style.background = 'rgba(255,255,255,0.03)';
      e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)';
    }}
    >
      {/* Rank */}
      <div style={{
        width: '32px',
        height: '32px',
        background: rank <= 3 
          ? 'linear-gradient(135deg, #ffd700 0%, #ff8c00 100%)'
          : 'rgba(255,255,255,0.1)',
        borderRadius: '8px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: '700',
        fontSize: '0.85rem',
        color: rank <= 3 ? '#000' : '#888',
        flexShrink: 0
      }}>
        {rank}
      </div>

      {/* Token Logo */}
      <div style={{
        width: '40px',
        height: '40px',
        borderRadius: '50%',
        background: 'rgba(255,255,255,0.1)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        flexShrink: 0
      }}>
        {token.image ? (
          <img 
            src={token.image} 
            alt={token.symbol} 
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            onError={(e) => { e.target.style.display = 'none'; }}
          />
        ) : (
          <span style={{ fontSize: '1.2rem' }}>🪙</span>
        )}
      </div>

      {/* Token Info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
          <span style={{ fontWeight: '700', fontSize: '1rem', textTransform: 'uppercase' }}>
            {token.symbol}
          </span>
        </div>
        <div style={{ 
          fontSize: '0.75rem', 
          color: '#888',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis'
        }}>
          {token.name}
        </div>
      </div>

      {/* Price & Change */}
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div style={{ fontWeight: '600', fontSize: '0.95rem' }}>
          {formatUSD(token.current_price || 0)}
        </div>
        <div style={{ 
          fontSize: '0.8rem', 
          fontWeight: '600',
          color: isPositive ? '#10b981' : '#ef4444'
        }}>
          {formatPercent(priceChange)}
        </div>
      </div>

      {/* Market Cap */}
      <div style={{ textAlign: 'right', minWidth: '80px', flexShrink: 0 }}>
        <div style={{ fontSize: '0.7rem', color: '#666', marginBottom: '2px' }}>MCap</div>
        <div style={{ fontSize: '0.85rem', fontWeight: '600' }}>
          {formatUSD(token.market_cap || 0)}
        </div>
      </div>

      {/* 24h Volume */}
      <div style={{ textAlign: 'right', minWidth: '80px', flexShrink: 0 }}>
        <div style={{ fontSize: '0.7rem', color: '#666', marginBottom: '2px' }}>24h Vol</div>
        <div style={{ fontSize: '0.85rem', fontWeight: '600' }}>
          {formatUSD(token.total_volume || 0)}
        </div>
      </div>

      {/* Track Button */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onTrack(token);
        }}
        style={{
          padding: '8px 12px',
          background: isTracked 
            ? 'rgba(16, 185, 129, 0.2)'
            : 'linear-gradient(135deg, #7b2ff7 0%, #f107a3 100%)',
          border: 'none',
          borderRadius: '8px',
          color: isTracked ? '#10b981' : '#fff',
          fontSize: '0.75rem',
          fontWeight: '600',
          cursor: 'pointer',
          flexShrink: 0,
          transition: 'all 0.2s ease'
        }}
      >
        {isTracked ? '✓ Tracked' : '+ Track'}
      </button>
    </div>
  );
};

// ============================================
// MARKET OVERVIEW SECTION (using CoinGecko)
// ============================================

const MarketOverview = ({ onTrackToken, trackedTokens }) => {
  const [allTokens, setAllTokens] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeMarketTab, setActiveMarketTab] = useState('top');

  const fetchMarketData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      // Fetch top 100 tokens by market cap from CoinGecko (free endpoint)
      // This gives us enough data to show top 25 + calculate gainers/losers
      const response = await fetch(
        '/api/moralis?source=coingecko&endpoint=/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false&price_change_percentage=24h'
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

  const isTokenTracked = (token) => {
    return trackedTokens.some(t => 
      t.symbol?.toLowerCase() === token.symbol?.toLowerCase()
    );
  };

  const handleTrack = (token) => {
    // For CoinGecko tokens, we need to find the contract address
    // Default to eth chain since CoinGecko doesn't specify in /coins/markets
    onTrackToken({
      address: token.id, // CoinGecko ID as fallback
      symbol: token.symbol?.toUpperCase(),
      name: token.name,
      chain: 'eth', // Default chain - user can change if needed
      logo: token.image || '🪙',
      coingeckoId: token.id
    });
  };

  // Get tokens based on active tab
  const getDisplayTokens = () => {
    const tokens = [...allTokens];
    
    switch (activeMarketTab) {
      case 'gainers':
        return tokens
          .filter(t => (t.price_change_percentage_24h || 0) > 0)
          .sort((a, b) => (b.price_change_percentage_24h || 0) - (a.price_change_percentage_24h || 0))
          .slice(0, 25);
      case 'losers':
        return tokens
          .filter(t => (t.price_change_percentage_24h || 0) < 0)
          .sort((a, b) => (a.price_change_percentage_24h || 0) - (b.price_change_percentage_24h || 0))
          .slice(0, 25);
      default: // 'top'
        return tokens.slice(0, 25);
    }
  };

  const displayTokens = getDisplayTokens();

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
          Data from CoinGecko • Updates every 5 min
        </div>
      </div>

      {/* Market Tabs */}
      <div style={{
        display: 'flex',
        gap: '8px',
        marginBottom: '16px',
        borderBottom: '1px solid rgba(255,255,255,0.1)',
        paddingBottom: '12px'
      }}>
        {[
          { id: 'top', label: '🏆 Top by Market Cap' },
          { id: 'gainers', label: '📈 Top Gainers (24h)' },
          { id: 'losers', label: '📉 Top Losers (24h)' }
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
      ) : displayTokens.length === 0 ? (
        <div style={{
          padding: '40px',
          textAlign: 'center',
          background: 'rgba(255,255,255,0.02)',
          borderRadius: '12px',
          color: '#888'
        }}>
          No tokens found
        </div>
      ) : (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '8px'
        }}>
          {displayTokens.map((token, idx) => (
            <TokenCard
              key={token.id}
              token={token}
              rank={idx + 1}
              onTrack={handleTrack}
              isTracked={isTokenTracked(token)}
            />
          ))}
        </div>
      )}
    </div>
  );
};

// ============================================
// TOKEN SEARCH COMPONENT (replaces TokenSelector)
// ============================================

const TokenSearch = ({ tokens, selectedToken, onSelect, onAddToken, onRemoveToken }) => {
  const [searchAddress, setSearchAddress] = useState('');
  const [searchChain, setSearchChain] = useState('eth');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(null);

  const handleSearch = async () => {
    if (!searchAddress || searchAddress.length < 30) {
      setSearchError('Please enter a valid contract address');
      return;
    }

    setSearching(true);
    setSearchError(null);

    try {
      // Try to fetch token metadata from Moralis
      let endpoint;
      if (searchChain === 'solana') {
        endpoint = `/token/mainnet/${searchAddress}/metadata`;
      } else {
        endpoint = `/erc20/metadata?chain=${searchChain}&addresses[]=${searchAddress}`;
      }

      const response = await fetch(
        `/api/moralis?endpoint=${encodeURIComponent(endpoint)}${searchChain === 'solana' ? '&chain=solana' : ''}`
      );

      if (response.ok) {
        const data = await response.json();
        const tokenData = searchChain === 'solana' ? data : data[0];

        if (tokenData) {
          const newToken = {
            address: searchAddress,
            symbol: tokenData.symbol || 'UNKNOWN',
            name: tokenData.name || 'Unknown Token',
            chain: searchChain,
            logo: tokenData.logo || tokenData.thumbnail || '🪙',
            decimals: tokenData.decimals
          };
          onAddToken(newToken);
          setSearchAddress('');
        } else {
          // Token not found but still add it
          onAddToken({
            address: searchAddress,
            symbol: 'UNKNOWN',
            name: 'Custom Token',
            chain: searchChain,
            logo: '🪙'
          });
          setSearchAddress('');
        }
      } else {
        // Add anyway with unknown info
        onAddToken({
          address: searchAddress,
          symbol: 'UNKNOWN',
          name: 'Custom Token',
          chain: searchChain,
          logo: '🪙'
        });
        setSearchAddress('');
      }
    } catch (err) {
      console.error('Token search error:', err);
      setSearchError('Failed to fetch token info. Adding with default values.');
      // Add anyway
      onAddToken({
        address: searchAddress,
        symbol: 'UNKNOWN',
        name: 'Custom Token',
        chain: searchChain,
        logo: '🪙'
      });
      setSearchAddress('');
    } finally {
      setSearching(false);
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
        marginBottom: '16px'
      }}>
        <div style={{ 
          fontSize: '0.75rem', 
          color: '#888', 
          marginBottom: '12px',
          textTransform: 'uppercase',
          letterSpacing: '1px'
        }}>
          🔍 Search for a token by contract address
        </div>
        <div style={{
          display: 'flex',
          gap: '12px',
          alignItems: 'flex-end',
          flexWrap: 'wrap'
        }}>
          <div style={{ flex: '1', minWidth: '300px' }}>
            <input
              type="text"
              value={searchAddress}
              onChange={(e) => setSearchAddress(e.target.value)}
              placeholder="Enter contract address (0x... or Solana address)"
              style={{
                width: '100%',
                padding: '12px 16px',
                background: 'rgba(0,0,0,0.3)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '8px',
                color: '#fff',
                fontSize: '0.9rem',
                fontFamily: 'monospace'
              }}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            />
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
          
          <button
            onClick={handleSearch}
            disabled={searching}
            style={{
              padding: '12px 24px',
              background: searching ? 'rgba(255,255,255,0.1)' : 'linear-gradient(135deg, #7b2ff7 0%, #f107a3 100%)',
              border: 'none',
              borderRadius: '8px',
              color: '#fff',
              fontSize: '0.9rem',
              fontWeight: '600',
              cursor: searching ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '8px'
            }}
          >
            {searching ? <LoadingSpinner size={16} /> : '🔍'}
            {searching ? 'Searching...' : 'Add Token'}
          </button>
        </div>

        {searchError && (
          <div style={{ color: '#f59e0b', fontSize: '0.8rem', marginTop: '8px' }}>
            ⚠️ {searchError}
          </div>
        )}
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
  const [activeView, setActiveView] = useState('market'); // 'market' or 'tracker'
  
  // Token management - no preset tokens
  const [tokens, setTokens] = useState(() => {
    const saved = localStorage.getItem('trackedTokens');
    return saved ? JSON.parse(saved) : [];
  });
  const [selectedToken, setSelectedToken] = useState(() => {
    const saved = localStorage.getItem('selectedToken');
    if (saved) {
      const parsed = JSON.parse(saved);
      return parsed;
    }
    return null;
  });

  // Data state
  const [holders, setHolders] = useState([]);
  const [previousHolders, setPreviousHolders] = useState({});
  const [transfers, setTransfers] = useState([]);
  const [tokenInfo, setTokenInfo] = useState(null);
  const [tokenPrice, setTokenPrice] = useState(0);
  
  // UI state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastSnapshot, setLastSnapshot] = useState(null);
  const [timeRemaining, setTimeRemaining] = useState(SNAPSHOT_INTERVAL);
  const [sortConfig, setSortConfig] = useState({ key: 'balance', direction: 'desc' });
  const [activeTab, setActiveTab] = useState('holders');

  // Save tokens to localStorage
  useEffect(() => {
    localStorage.setItem('trackedTokens', JSON.stringify(tokens));
  }, [tokens]);

  useEffect(() => {
    if (selectedToken) {
      localStorage.setItem('selectedToken', JSON.stringify(selectedToken));
    }
  }, [selectedToken]);

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

  // Fetch token metadata (EVM)
  const fetchTokenInfo = useCallback(async () => {
    if (!selectedToken) return null;
    
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
    if (!selectedToken) return 0;
    
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
    if (!selectedToken) return [];
    
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
    
    const data = await fetchFromAPI(
      `/erc20/${selectedToken.address}/owners?chain=${selectedToken.chain}&limit=100&order=DESC`
    );
    return data.result || [];
  }, [selectedToken]);

  // Fetch recent transfers
  const fetchTransfers = useCallback(async () => {
    if (!selectedToken) return [];
    
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
    
    setLoading(true);
    setError(null);
    
    try {
      const [holdersData, price, transfersData, info] = await Promise.all([
        fetchHolders(),
        fetchTokenPrice(),
        fetchTransfers(),
        fetchTokenInfo()
      ]);

      // Store previous holders for comparison
      const prevMap = {};
      holders.forEach(h => {
        prevMap[h.owner_address] = parseFloat(h.balance_formatted || h.balance);
      });
      setPreviousHolders(prevMap);

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
  }, [fetchHolders, fetchTokenPrice, fetchTransfers, fetchTokenInfo, holders, selectedToken]);

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
      t.address?.toLowerCase() === token.address?.toLowerCase() && 
      t.chain === token.chain
    );
    if (!exists) {
      const newTokens = [...tokens, token];
      setTokens(newTokens);
      setSelectedToken(token);
      setActiveView('tracker');
    } else {
      // Select existing token
      const existingToken = tokens.find(t => 
        t.address?.toLowerCase() === token.address?.toLowerCase() && 
        t.chain === token.chain
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
    
    // If removing selected token, select first remaining or null
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
        aVal = parseFloat(a.balance_formatted || a.balance);
        bVal = parseFloat(b.balance_formatted || b.balance);
      } else if (sortConfig.key === 'usd') {
        aVal = parseFloat(a.usd_value || 0);
        bVal = parseFloat(b.usd_value || 0);
      } else if (sortConfig.key === 'percentage') {
        aVal = parseFloat(a.percentage_relative_to_total_supply || 0);
        bVal = parseFloat(b.percentage_relative_to_total_supply || 0);
      } else if (sortConfig.key === 'change') {
        const aBalance = parseFloat(a.balance_formatted || a.balance);
        const bBalance = parseFloat(b.balance_formatted || b.balance);
        const aPrev = previousHolders[a.owner_address] || aBalance;
        const bPrev = previousHolders[b.owner_address] || bBalance;
        aVal = aBalance - aPrev;
        bVal = bBalance - bPrev;
      }
      
      return sortConfig.direction === 'desc' ? bVal - aVal : aVal - bVal;
    });
    return sorted;
  }, [holders, sortConfig, previousHolders]);

  // Calculate top 10% threshold
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
      fontFamily: '"JetBrains Mono", "Fira Code", "SF Mono", monospace',
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
            {/* Token Search */}
            <TokenSearch
              tokens={tokens}
              selectedToken={selectedToken}
              onSelect={setSelectedToken}
              onAddToken={handleAddToken}
              onRemoveToken={handleRemoveToken}
            />

            {/* No token selected state */}
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
                  Search for a token by contract address above, or go to Market Overview to find tokens to track.
                </p>
              </div>
            )}

            {/* Token selected - show data */}
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
                      {lastSnapshot ? lastSnapshot.toLocaleString() : 'Loading...'}
                    </div>
                  </div>
                  <button
                    onClick={loadSnapshot}
                    disabled={loading}
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
                      gap: '8px'
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

                {/* Tabs */}
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
                            <th style={thStyle}>#</th>
                            <th style={thStyle}>Wallet</th>
                            <th style={{ ...thStyle, cursor: 'pointer' }} onClick={() => handleSort('balance')}>
                              Balance <SortIcon column="balance" />
                            </th>
                            <th style={{ ...thStyle, cursor: 'pointer' }} onClick={() => handleSort('usd')}>
                              USD Value <SortIcon column="usd" />
                            </th>
                            <th style={{ ...thStyle, cursor: 'pointer' }} onClick={() => handleSort('percentage')}>
                              % Supply <SortIcon column="percentage" />
                            </th>
                            <th style={thStyle}>Type</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sortedHolders.map((holder, idx) => {
                            const balance = parseFloat(holder.balance_formatted || holder.balance);
                            const usdValue = balance * tokenPrice;
                            const pct = parseFloat(holder.percentage_relative_to_total_supply || 0);
                            
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
                                <td style={tdStyle}>
                                  <span style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    width: '28px',
                                    height: '28px',
                                    background: idx < 3 
                                      ? 'linear-gradient(135deg, #ffd700 0%, #ff8c00 100%)'
                                      : 'rgba(255,255,255,0.1)',
                                    borderRadius: '6px',
                                    fontSize: '0.75rem',
                                    fontWeight: '700',
                                    color: idx < 3 ? '#000' : '#888'
                                  }}>
                                    {idx + 1}
                                  </span>
                                </td>
                                <td style={tdStyle}>
                                  <AddressDisplay 
                                    address={holder.owner_address} 
                                    chain={selectedToken.chain}
                                    label={holder.owner_address_label}
                                  />
                                </td>
                                <td style={tdStyle}>
                                  <span style={{ fontWeight: '600' }}>{formatNumber(balance)}</span>
                                  <span style={{ color: '#666', marginLeft: '4px' }}>
                                    {tokenInfo?.symbol || selectedToken.symbol}
                                  </span>
                                </td>
                                <td style={tdStyle}>
                                  <span style={{ color: '#10b981', fontWeight: '600' }}>
                                    {formatUSD(usdValue)}
                                  </span>
                                </td>
                                <td style={tdStyle}>
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
                                <td style={tdStyle}>
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
                  </div>
                )}

                {/* Transfers Table */}
                {!loading && activeTab === 'transfers' && transfers.length > 0 && (
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
                            <th style={thStyle}>#</th>
                            <th style={thStyle}>Type</th>
                            <th style={thStyle}>From</th>
                            <th style={thStyle}>To</th>
                            <th style={thStyle}>Amount</th>
                            <th style={thStyle}>USD Value</th>
                            <th style={thStyle}>Time</th>
                          </tr>
                        </thead>
                        <tbody>
                          {processedTransfers.slice(0, 25).map((transfer, idx) => (
                            <tr 
                              key={`${transfer.transaction_hash}-${idx}`}
                              style={{
                                borderBottom: '1px solid rgba(255,255,255,0.05)',
                                transition: 'background 0.2s ease'
                              }}
                              onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
                              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                            >
                              <td style={tdStyle}>
                                <span style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  width: '28px',
                                  height: '28px',
                                  background: idx < 3 
                                    ? 'linear-gradient(135deg, #10b981 0%, #059669 100%)'
                                    : 'rgba(255,255,255,0.1)',
                                  borderRadius: '6px',
                                  fontSize: '0.75rem',
                                  fontWeight: '700',
                                  color: idx < 3 ? '#fff' : '#888'
                                }}>
                                  {idx + 1}
                                </span>
                              </td>
                              <td style={tdStyle}>
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
                              <td style={tdStyle}>
                                <AddressDisplay 
                                  address={transfer.from_address} 
                                  chain={selectedToken.chain}
                                  color="#ef4444"
                                />
                              </td>
                              <td style={tdStyle}>
                                <AddressDisplay 
                                  address={transfer.to_address} 
                                  chain={selectedToken.chain}
                                  color="#10b981"
                                />
                              </td>
                              <td style={tdStyle}>
                                <span style={{ fontWeight: '600' }}>{formatNumber(transfer.amount)}</span>
                                <span style={{ color: '#666', marginLeft: '4px' }}>
                                  {tokenInfo?.symbol || selectedToken.symbol}
                                </span>
                              </td>
                              <td style={tdStyle}>
                                <span style={{ 
                                  color: transfer.usdValue > 10000 ? '#ffd700' : '#10b981', 
                                  fontWeight: '700'
                                }}>
                                  {formatUSD(transfer.usdValue)}
                                  {transfer.usdValue > 100000 && ' 🔥'}
                                </span>
                              </td>
                              <td style={tdStyle}>
                                <a 
                                  href={`${network.explorer}/tx/${transfer.transaction_hash}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  style={{ color: '#888', fontSize: '0.8rem', textDecoration: 'none' }}
                                >
                                  {transfer.block_timestamp 
                                    ? new Date(transfer.block_timestamp).toLocaleString()
                                    : `Block #${transfer.block_number}`
                                  }
                                </a>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
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
          <p>Market data powered by CoinGecko • Whale tracking powered by Moralis</p>
          <p style={{ marginTop: '8px' }}>
            {tokens.length > 0 ? `Tracking ${tokens.length} tokens` : 'No tokens tracked'} • {Object.keys(NETWORKS).length} networks supported
          </p>
        </div>
      </div>
    </div>
  );
}

// ============================================
// STYLES
// ============================================

const thStyle = {
  padding: '16px',
  textAlign: 'left',
  fontWeight: '600',
  fontSize: '0.75rem',
  textTransform: 'uppercase',
  letterSpacing: '1px',
  color: '#888'
};

const tdStyle = {
  padding: '14px 16px',
  verticalAlign: 'middle'
};
