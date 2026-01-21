export default async function handler(req, res) {
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
  const coingeckoApiKey = process.env.COINGECKO_API_KEY; // Optional

  try {
    let apiUrl;
    let headers = { 'Accept': 'application/json' };

    // Route to CoinGecko for market overview data and search
    if (source === 'coingecko') {
      apiUrl = `https://api.coingecko.com/api/v3${endpoint}`;
      if (coingeckoApiKey) {
        headers['x-cg-demo-api-key'] = coingeckoApiKey;
      }
    }
    // Route to Solana API
    else if (chain === 'solana' || endpoint.startsWith('/solana')) {
      if (!moralisApiKey) {
        return res.status(500).json({ error: 'Moralis API key not configured' });
      }
      apiUrl = `https://solana-gateway.moralis.io${endpoint}`;
      headers['X-API-Key'] = moralisApiKey;
    }
    // Default to Moralis EVM API
    else {
      if (!moralisApiKey) {
        return res.status(500).json({ error: 'Moralis API key not configured' });
      }
      apiUrl = `https://deep-index.moralis.io/api/v2.2${endpoint}`;
      headers['X-API-Key'] = moralisApiKey;
    }
    
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers
    });

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
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
    return res.status(200).json(data);
  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ 
      error: 'Failed to fetch data',
      details: error.message 
    });
  }
}
