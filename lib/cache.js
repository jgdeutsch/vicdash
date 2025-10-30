export function getCachedStats() {
  return globalThis.__vicdashCachedStats || null;
}

export function setCachedStats(data) {
  globalThis.__vicdashCachedStats = data;
}


