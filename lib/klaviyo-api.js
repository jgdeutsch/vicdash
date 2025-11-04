const BASE_URL = 'https://a.klaviyo.com/api';
const REVISION = '2024-07-15';

function getHeaders(apiKey) {
  return {
    'Authorization': `Klaviyo-API-Key ${apiKey}`,
    'accept': 'application/json',
    'revision': REVISION,
  };
}

async function fetchWithRetry(url, options, maxRetries = 5, initialDelay = 1000) {
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000);
      
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);

      if (response.status === 429) {
        const retryAfter = Number(response.headers.get('Retry-After')) || 1;
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
          continue;
        }
      }

      if (response.status >= 500 && response.status < 600) {
        if (attempt < maxRetries) {
          const delay = initialDelay * Math.pow(2, attempt);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
      }

      return response;
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        const delay = initialDelay * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError || new Error('Request failed after retries');
}

export async function getMetricId(metricName, apiKey) {
  const url = `${BASE_URL}/metrics/?fields[metric]=name`;
  const response = await fetchWithRetry(url, {
    method: 'GET',
    headers: getHeaders(apiKey),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch metrics: ${response.status}`);
  }

  const data = await response.json();
  const metric = data.data?.find(m => m.attributes?.name === metricName);
  return metric?.id || null;
}

export async function getProfileByEmail(email, apiKey) {
  const encodedEmail = encodeURIComponent(email);
  const url = `${BASE_URL}/profiles/?filter=equals(email,"${encodedEmail}")`;
  
  const response = await fetchWithRetry(url, {
    method: 'GET',
    headers: getHeaders(apiKey),
  });

  if (!response.ok) {
    if (response.status === 404) {
      return null;
    }
    throw new Error(`Failed to fetch profile: ${response.status}`);
  }

  const data = await response.json();
  return data.data?.[0]?.id || null;
}

export async function checkEventForProfile(profileId, metricId, apiKey) {
  let url = `${BASE_URL}/profiles/${profileId}/events/?filter=equals(metric_id,${metricId})&page[size]=100`;
  
  while (url) {
    const response = await fetchWithRetry(url, {
      method: 'GET',
      headers: getHeaders(apiKey),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch events: ${response.status}`);
    }

    const data = await response.json();
    
    if (data.data && data.data.length > 0) {
      return true;
    }

    url = data.links?.next || null;
  }

  return false;
}

export async function checkFlowEmail(profileId, flowId, apiKey) {
  const receivedEmailMetricId = await getMetricId('Received Email', apiKey);
  if (!receivedEmailMetricId) {
    return false;
  }

  let url = `${BASE_URL}/profiles/${profileId}/events/?filter=equals(metric_id,${receivedEmailMetricId})&page[size]=100&fields[event]=event_properties,datetime,id`;
  
  while (url) {
    const response = await fetchWithRetry(url, {
      method: 'GET',
      headers: getHeaders(apiKey),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch flow events: ${response.status}`);
    }

    const data = await response.json();
    
    if (data.data) {
      for (const event of data.data) {
        const eventProperties = event.attributes?.event_properties;
        if (eventProperties && eventProperties.$flow === flowId) {
          return true;
        }
      }
    }

    url = data.links?.next || null;
  }

  return false;
}

