import { getCachedStats } from './lib/cache.js';

try {
  console.log('Fetching cached stats...');
  const cached = await getCachedStats();
  console.log('Cached data:', JSON.stringify(cached, null, 2));
  if (cached?.campaigns) {
    console.log('Campaigns count:', Object.keys(cached.campaigns).length);
    console.log('First campaign:', Object.keys(cached.campaigns)[0]);
  }
} catch (e) {
  console.error('Error:', e);
}

