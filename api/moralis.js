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

  const { endpoint, chain } = req.query;

  if (!endpoint) {
    return res.status(400).json({ error: 'Missing endpoint parameter' });
  }

  const apiKey = process.env.MORALIS_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  try {
    // Determine if this is a Solana or EVM request
    const isSolana = chain === 'solana' || endpoint.startsWith('/solana');
    
    let moralisUrl;
    if (isSolana) {
      // Solana API base URL
      moralisUrl = `https://solana-gateway.moralis.io${endpoint}`;
    } else {
      // EVM API base URL
      moralisUrl = `https://deep-index.moralis.io/api/v2.2${endpoint}`;
    }
    
    const response = await fetch(moralisUrl, {
      method: 'GET',
      headers: {
        'X-API-Key': apiKey,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ 
        error: `Moralis API error: ${response.status}`,
        details: errorText
      });
    }

    const data = await response.json();
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    return res.status(200).json(data);
  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ 
      error: 'Failed to fetch from Moralis',
      details: error.message 
    });
  }
}
