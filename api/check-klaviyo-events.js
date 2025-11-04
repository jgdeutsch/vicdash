import { getProfileByEmail, getMetricId, checkEventForProfile, checkFlowEmail } from '../lib/klaviyo-api.js';

function checkAuth(req, res) {
  const pass = process.env.DASHBOARD_PASSWORD || '#$F(jfi4f;w-lf-21)';
  if (!pass) return true;
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="VicDash"');
    res.status(401).end('Auth required');
    return false;
  }
  const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
  const password = decoded.split(':').slice(1).join(':');
  const ok = password === pass;
  if (!ok) {
    res.setHeader('WWW-Authenticate', 'Basic realm="VicDash"');
    res.status(401).end('Auth required');
  }
  return ok;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }
  if (!checkAuth(req, res)) return;

  try {
    const { email } = await new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => { body += chunk; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });

    if (!email || typeof email !== 'string') {
      res.status(400).json({ error: 'Email is required' });
      return;
    }

    const apiKey = process.env.KLAVIYO_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: 'KLAVIYO_API_KEY not configured' });
      return;
    }

    // Step 1: Get profile by email
    const profileId = await getProfileByEmail(email, apiKey);
    if (!profileId) {
      res.status(404).json({ error: 'Profile not found', email });
      return;
    }

    // Step 2: Check SUBSCRIPTION_CREATED
    let subscriptionCreated = false;
    try {
      const metricId = await getMetricId('SUBSCRIPTION_CREATED', apiKey);
      if (metricId) {
        subscriptionCreated = await checkEventForProfile(profileId, metricId, apiKey);
      }
    } catch (e) {
      console.error('Error checking SUBSCRIPTION_CREATED:', e);
    }

    // Step 3: Check Lab Test Scheduled (Flow UGW5Jf)
    let labTestScheduled = false;
    try {
      labTestScheduled = await checkFlowEmail(profileId, 'UGW5Jf', apiKey);
    } catch (e) {
      console.error('Error checking Lab Test Scheduled:', e);
    }

    // Step 4: Check viewed_aiap
    let viewedAiap = false;
    try {
      const metricId = await getMetricId('viewed_aiap', apiKey);
      if (metricId) {
        viewedAiap = await checkEventForProfile(profileId, metricId, apiKey);
      }
    } catch (e) {
      console.error('Error checking viewed_aiap:', e);
    }

    res.status(200).json({
      email,
      events: {
        subscriptionCreated,
        labTestScheduled,
        viewedAiap,
      },
    });
  } catch (error) {
    console.error('Klaviyo check error:', error);
    res.status(500).json({ error: String(error?.message || error) });
  }
}

