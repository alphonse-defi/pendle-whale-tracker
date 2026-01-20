import React, { useState, useEffect, useCallback } from 'react';

const PENDLE_CONTRACT = '0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8';
const CHAIN = 'arbitrum';
const SNAPSHOT_INTERVAL = 12 * 60 * 60 * 1000; // 12 hours in ms

// Utility functions
const formatNumber = (num, decimals = 2) => {
  if (num >= 1e9) return (num / 1e9).toFixed(decimals) + 'B';
  if (num >= 1e6) return (num / 1e6).toFixed(decimals) + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(decimals) + 'K';
  return num.toFixed(decimals);
};

const formatUSD = (num) => {
  return '$' + formatNumber(num);
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

export default function App() {
  const [holders, setHolders] = useState([]);
  const [previousHolders, setPreviousHolders] = useState({});
  const [transfers, setTransfers] = useState([]);
  const [tokenPrice, setTokenPrice] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastSnapshot, setLastSnapshot] = useState(null);
  const [timeRemaining, setTimeRemaining] = useState(SNAPSHOT_INTERVAL);
  const [sortConfig, setSortConfig] = useState({ key: 'balance', direction: 'desc' });
  const [activeTab, setActiveTab] = useState('holders');

  // Fetch from our serverless API (which proxies to Moralis)
  const fetchFromAPI = async (endpoint) => {
    const response = await fetch(`/api/moralis?endpoint=${encodeURIComponent(endpoint)}`);
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `API Error: ${response.status}`);
    }
    return response.json();
  };

  // Fetch token price
  const fetchTokenPrice = useCallback(async () => {
    try {
      const data = await fetchFromAPI(`/erc20/${PENDLE_CONTRACT}/price?chain=${CHAIN}`);
      return data.usdPrice || 0;
    } catch (err) {
      console.error('Price fetch error:', err);
      return 0;
    }
  }, []);

  // Fetch top holders
  const fetchHolders = useCallback(async () => {
    const data = await fetchFromAPI(`/erc20/${PENDLE_CONTRACT}/owners?chain=${CHAIN}&limit=100&order=DESC`);
    return data.result || [];
  }, []);

  // Fetch recent transfers
  const fetchTransfers = useCallback(async () => {
    try {
      const data = await fetchFromAPI(`/erc20/${PENDLE_CONTRACT}/transfers?chain=${CHAIN}&limit=50&order=DESC`);
      return data.result || [];
    } catch (err) {
      console.error('Transfers fetch error:', err);
      return [];
    }
  }, []);

  // Load snapshot data
  const loadSnapshot = useCallback(async () => {
    setLoading(true);
    setError(null);
    
    try {
      const [holdersData, price, transfersData] = await Promise.all([
        fetchHolders(),
        fetchTokenPrice(),
        fetchTransfers()
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
      setLastSnapshot(new Date());
      setTimeRemaining(SNAPSHOT_INTERVAL);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [fetchHolders, fetchTokenPrice, fetchTransfers, holders]);

  // Initial load
  useEffect(() => {
    loadSnapshot();
  }, []);

  // Countdown timer
  useEffect(() => {
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
  }, [loadSnapshot]);

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
  const top10PercentHolders = sortedHolders.slice(0, top10PercentCount);

  // Process transfers for largest buys/sells
  const processedTransfers = React.useMemo(() => {
    return transfers.map(t => {
      const decimals = parseInt(t.token_decimals || 18);
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
  }, [transfers, tokenPrice]);

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

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #0a0a0f 0%, #1a1a2e 50%, #0f0f1a 100%)',
      color: '#e0e0e0',
      fontFamily: '"JetBrains Mono", "Fira Code", "SF Mono", monospace',
      padding: '20px'
    }}>
      {/* Header */}
      <div style={{
        maxWidth: '1400px',
        margin: '0 auto',
        marginBottom: '30px'
      }}>
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          flexWrap: 'wrap',
          gap: '20px'
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
              🐋 PENDLE Whale Tracker
            </h1>
            <p style={{
              margin: 0,
              color: '#888',
              fontSize: '0.9rem'
            }}>
              Arbitrum Network • Contract: {shortenAddress(PENDLE_CONTRACT)}
            </p>
          </div>
          
          {/* Timer Card */}
          <div style={{
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '16px',
            padding: '16px 24px',
            textAlign: 'center',
            backdropFilter: 'blur(10px)'
          }}>
            <div style={{ 
              fontSize: '0.75rem', 
              color: '#888', 
              textTransform: 'uppercase',
              letterSpacing: '2px',
              marginBottom: '8px'
            }}>
              Next Snapshot In
            </div>
            <div style={{
              fontSize: '2rem',
              fontWeight: '700',
              fontFamily: '"JetBrains Mono", monospace',
              color: timeRemaining < 3600000 ? '#f107a3' : '#00d4ff'
            }}>
              {formatTimeRemaining(timeRemaining)}
            </div>
            {lastSnapshot && (
              <div style={{ fontSize: '0.7rem', color: '#666', marginTop: '8px' }}>
                Last: {lastSnapshot.toLocaleTimeString()}
              </div>
            )}
          </div>
        </div>

        {/* Stats Row */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: '16px',
          marginTop: '24px'
        }}>
          <StatCard 
            label="PENDLE Price" 
            value={tokenPrice > 0 ? `$${tokenPrice.toFixed(4)}` : 'Loading...'}
            icon="💰"
          />
          <StatCard 
            label="Total Holders Tracked" 
            value={holders.length.toString()}
            icon="👥"
          />
          <StatCard 
            label="Top 10% Count" 
            value={top10PercentCount.toString()}
            icon="🐋"
          />
          <StatCard 
            label="Recent Transfers" 
            value={transfers.length.toString()}
            icon="📊"
          />
        </div>
      </div>

      {/* Tabs */}
      <div style={{ maxWidth: '1400px', margin: '0 auto' }}>
        <div style={{
          display: 'flex',
          gap: '8px',
          marginBottom: '20px',
          flexWrap: 'wrap',
          alignItems: 'center'
        }}>
          {['holders', 'transfers'].map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                padding: '12px 24px',
                background: activeTab === tab 
                  ? 'linear-gradient(135deg, #7b2ff7 0%, #f107a3 100%)'
                  : 'rgba(255,255,255,0.05)',
                border: 'none',
                borderRadius: '8px',
                color: '#fff',
                fontSize: '0.9rem',
                fontWeight: '600',
                cursor: 'pointer',
                textTransform: 'capitalize',
                transition: 'all 0.2s ease'
              }}
            >
              {tab === 'holders' ? '🐋 Top 10% Holders' : '📈 Largest Transfers'}
            </button>
          ))}
          
          <div style={{ marginLeft: 'auto' }}>
            <button
              onClick={loadSnapshot}
              disabled={loading}
              style={{
                padding: '12px 24px',
                background: loading ? '#333' : 'rgba(0, 212, 255, 0.2)',
                border: '1px solid #00d4ff',
                borderRadius: '8px',
                color: '#00d4ff',
                fontSize: '0.9rem',
                fontWeight: '600',
                cursor: loading ? 'not-allowed' : 'pointer',
                transition: 'all 0.2s ease'
              }}
            >
              {loading ? '⏳ Loading...' : '🔄 Refresh Now'}
            </button>
          </div>
        </div>

        {/* Error State */}
        {error && (
          <div style={{
            background: 'rgba(255, 50, 50, 0.1)',
            border: '1px solid rgba(255, 50, 50, 0.3)',
            borderRadius: '12px',
            padding: '16px',
            marginBottom: '20px',
            color: '#ff6b6b'
          }}>
            <div style={{ marginBottom: '8px' }}>⚠️ Error: {error}</div>
            <div style={{ fontSize: '0.85rem', color: '#999' }}>
              Please check that the API is configured correctly. Try refreshing the page.
            </div>
          </div>
        )}

        {/* Loading State */}
        {loading && holders.length === 0 && (
          <div style={{
            textAlign: 'center',
            padding: '60px 20px',
            color: '#888'
          }}>
            <div style={{ 
              fontSize: '3rem', 
              marginBottom: '16px',
              animation: 'spin 1s linear infinite'
            }}>🔄</div>
            <div>Loading whale data from Moralis...</div>
          </div>
        )}

        {/* Holders Table */}
        {activeTab === 'holders' && holders.length > 0 && (
          <div style={{
            background: 'rgba(255,255,255,0.02)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '16px',
            overflow: 'hidden'
          }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: '0.85rem'
              }}>
                <thead>
                  <tr style={{ 
                    background: 'rgba(255,255,255,0.05)',
                    borderBottom: '1px solid rgba(255,255,255,0.1)'
                  }}>
                    <th style={thStyle}>#</th>
                    <th style={thStyle}>Address</th>
                    <th 
                      style={{ ...thStyle, cursor: 'pointer' }}
                      onClick={() => handleSort('balance')}
                    >
                      Balance <SortIcon column="balance" />
                    </th>
                    <th 
                      style={{ ...thStyle, cursor: 'pointer' }}
                      onClick={() => handleSort('usd')}
                    >
                      USD Value <SortIcon column="usd" />
                    </th>
                    <th 
                      style={{ ...thStyle, cursor: 'pointer' }}
                      onClick={() => handleSort('percentage')}
                    >
                      % Supply <SortIcon column="percentage" />
                    </th>
                    <th 
                      style={{ ...thStyle, cursor: 'pointer' }}
                      onClick={() => handleSort('change')}
                    >
                      Change <SortIcon column="change" />
                    </th>
                    <th style={thStyle}>Type</th>
                  </tr>
                </thead>
                <tbody>
                  {top10PercentHolders.map((holder, idx) => {
                    const balance = parseFloat(holder.balance_formatted || holder.balance);
                    const prevBalance = previousHolders[holder.owner_address];
                    const change = prevBalance ? balance - prevBalance : 0;
                    const changePercent = prevBalance ? ((change / prevBalance) * 100) : 0;
                    const usdValue = parseFloat(holder.usd_value || (balance * tokenPrice));
                    
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
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <a 
                              href={`https://arbiscan.io/address/${holder.owner_address}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ 
                                fontFamily: 'monospace',
                                color: '#00d4ff',
                                textDecoration: 'none'
                              }}
                            >
                              {shortenAddress(holder.owner_address)}
                            </a>
                            {holder.owner_address_label && (
                              <span style={{
                                background: 'rgba(123, 47, 247, 0.2)',
                                color: '#a855f7',
                                padding: '2px 8px',
                                borderRadius: '4px',
                                fontSize: '0.7rem'
                              }}>
                                {holder.owner_address_label}
                              </span>
                            )}
                          </div>
                        </td>
                        <td style={tdStyle}>
                          <span style={{ fontWeight: '600' }}>
                            {formatNumber(balance)}
                          </span>
                          <span style={{ color: '#666', marginLeft: '4px' }}>PENDLE</span>
                        </td>
                        <td style={tdStyle}>
                          <span style={{ color: '#10b981', fontWeight: '600' }}>
                            {formatUSD(usdValue)}
                          </span>
                        </td>
                        <td style={tdStyle}>
                          <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px'
                          }}>
                            <div style={{
                              width: '60px',
                              height: '6px',
                              background: 'rgba(255,255,255,0.1)',
                              borderRadius: '3px',
                              overflow: 'hidden'
                            }}>
                              <div style={{
                                width: `${Math.min((holder.percentage_relative_to_total_supply || 0) * 3, 100)}%`,
                                height: '100%',
                                background: 'linear-gradient(90deg, #7b2ff7, #f107a3)',
                                borderRadius: '3px'
                              }} />
                            </div>
                            <span style={{ color: '#888', fontSize: '0.8rem' }}>
                              {parseFloat(holder.percentage_relative_to_total_supply || 0).toFixed(2)}%
                            </span>
                          </div>
                        </td>
                        <td style={tdStyle}>
                          {change !== 0 ? (
                            <span style={{
                              color: change > 0 ? '#10b981' : '#ef4444',
                              fontWeight: '600',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '4px'
                            }}>
                              {change > 0 ? '▲' : '▼'}
                              {formatNumber(Math.abs(change))}
                              <span style={{ 
                                fontSize: '0.7rem', 
                                opacity: 0.7 
                              }}>
                                ({changePercent > 0 ? '+' : ''}{changePercent.toFixed(1)}%)
                              </span>
                            </span>
                          ) : (
                            <span style={{ color: '#666' }}>—</span>
                          )}
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
        {activeTab === 'transfers' && transfers.length > 0 && (
          <div style={{
            background: 'rgba(255,255,255,0.02)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '16px',
            overflow: 'hidden'
          }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: '0.85rem'
              }}>
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
                    <th style={thStyle}>Block</th>
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
                        <a 
                          href={`https://arbiscan.io/address/${transfer.from_address}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ fontFamily: 'monospace', color: '#ef4444', textDecoration: 'none' }}
                        >
                          {shortenAddress(transfer.from_address)}
                        </a>
                      </td>
                      <td style={tdStyle}>
                        <a 
                          href={`https://arbiscan.io/address/${transfer.to_address}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ fontFamily: 'monospace', color: '#10b981', textDecoration: 'none' }}
                        >
                          {shortenAddress(transfer.to_address)}
                        </a>
                      </td>
                      <td style={tdStyle}>
                        <span style={{ fontWeight: '600' }}>
                          {formatNumber(transfer.amount)}
                        </span>
                        <span style={{ color: '#666', marginLeft: '4px' }}>PENDLE</span>
                      </td>
                      <td style={tdStyle}>
                        <span style={{ 
                          color: transfer.usdValue > 10000 ? '#ffd700' : '#10b981', 
                          fontWeight: '700',
                          fontSize: transfer.usdValue > 100000 ? '1rem' : '0.85rem'
                        }}>
                          {formatUSD(transfer.usdValue)}
                          {transfer.usdValue > 100000 && ' 🔥'}
                        </span>
                      </td>
                      <td style={tdStyle}>
                        <a 
                          href={`https://arbiscan.io/tx/${transfer.transaction_hash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: '#888', fontSize: '0.8rem', textDecoration: 'none' }}
                        >
                          #{transfer.block_number}
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Empty state for tables */}
        {!loading && holders.length === 0 && !error && (
          <div style={{
            textAlign: 'center',
            padding: '60px 20px',
            color: '#888',
            background: 'rgba(255,255,255,0.02)',
            borderRadius: '16px',
            border: '1px solid rgba(255,255,255,0.08)'
          }}>
            <div style={{ fontSize: '3rem', marginBottom: '16px' }}>📭</div>
            <div>No data loaded yet. Click "Refresh Now" to fetch whale data.</div>
          </div>
        )}

        {/* Footer */}
        <div style={{
          textAlign: 'center',
          padding: '40px 20px',
          color: '#666',
          fontSize: '0.8rem'
        }}>
          <p>Data powered by Moralis API • Arbitrum Network</p>
          <p style={{ marginTop: '8px' }}>
            Tracking top {top10PercentCount} holders ({((top10PercentCount / holders.length) * 100 || 0).toFixed(0)}% of tracked addresses)
          </p>
        </div>
      </div>
    </div>
  );
}

// Stat Card Component
const StatCard = ({ label, value, icon }) => (
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
    </div>
  </div>
);

// Table Styles
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
