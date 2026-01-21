// Enhanced API handler with rate limiting awareness
export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { endpoint, chain, source } = req.query;

  if (!endpoint) {
    return res.status(400).json({ error: 'Missing endpoint parameter' });
  }

  const moralisApiKey = process.env.MORALIS_API_KEY;
  const coingeckoApiKey = process.env.COINGECKO_API_KEY;

  try {
    let apiUrl;
    let headers = { 'Accept': 'application/json' };
    let cacheDuration = 60; // Default 1 minute cache

    // Route to CoinGecko for market overview data and search
    if (source === 'coingecko') {
      apiUrl = `https://api.coingecko.com/api/v3${endpoint}`;
      if (coingeckoApiKey) {
        headers['x-cg-demo-api-key'] = coingeckoApiKey;
      }
      
      // Adjust cache based on endpoint type
      if (endpoint.includes('/markets')) {
        cacheDuration = 300; // 5 min for market data
      } else if (endpoint.includes('/search')) {
        cacheDuration = 3600; // 1 hour for search results
      } else if (endpoint.includes('/coins/')) {
        cacheDuration = 600; // 10 min for coin details
      }
    }
    // Route to Solana API
    else if (chain === 'solana' || endpoint.startsWith('/solana') || endpoint.startsWith('/token/mainnet')) {
      if (!moralisApiKey) {
        return res.status(500).json({ error: 'Moralis API key not configured' });
      }
      apiUrl = `https://solana-gateway.moralis.io${endpoint}`;
      headers['X-API-Key'] = moralisApiKey;
      
      // Adjust cache for Solana endpoints
      if (endpoint.includes('/holders')) {
        cacheDuration = 300; // 5 min for holders
      } else if (endpoint.includes('/price')) {
        cacheDuration = 60; // 1 min for price
      } else if (endpoint.includes('/swaps') || endpoint.includes('/transfers')) {
        cacheDuration = 120; // 2 min for transactions
      }
    }
    // Default to Moralis EVM API
    else {
      if (!moralisApiKey) {
        return res.status(500).json({ error: 'Moralis API key not configured' });
      }
      apiUrl = `https://deep-index.moralis.io/api/v2.2${endpoint}`;
      headers['X-API-Key'] = moralisApiKey;
      
      // Adjust cache for EVM endpoints
      if (endpoint.includes('/owners')) {
        cacheDuration = 300; // 5 min for holders
      } else if (endpoint.includes('/price')) {
        cacheDuration = 60; // 1 min for price
      } else if (endpoint.includes('/transfers')) {
        cacheDuration = 120; // 2 min for transfers
      } else if (endpoint.includes('/metadata')) {
        cacheDuration = 3600; // 1 hour for metadata
      }
    }
    
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers
    });

    // Handle rate limiting
    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After') || '60';
      return res.status(429).json({ 
        error: 'Rate limited. Please try again later.',
        retryAfter: parseInt(retryAfter),
        message: 'API rate limit exceeded. The app will automatically retry.'
      });
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`API Error from ${apiUrl}:`, errorText);
      return res.status(response.status).json({ 
        error: `API error: ${response.status}`,
        details: errorText,
        url: apiUrl
      });
    }

    const data = await response.json();
    
    // Set cache headers based on endpoint type
    res.setHeader('Cache-Control', `s-maxage=${cacheDuration}, stale-while-revalidate=${cacheDuration * 2}`);
    
    return res.status(200).json(data);
  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ 
      error: 'Failed to fetch data',
      details: error.message 
    });
  }
}
