async function request(path, signal, options = {}) {
  const response = await fetch(`/api${path}`, { ...options, signal, headers: { Accept: 'application/json', ...options.headers } });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const safeMessage = [400, 422, 503].includes(response.status) && typeof body?.error?.message === 'string' ? body.error.message : null;
    const error = new Error(safeMessage || (response.status === 404 ? 'This record is no longer available.' : 'The research collection could not be reached. Please try again.'));
    error.status = response.status;
    throw error;
  }
  return response.json();
}

export async function getRecommendations(params, demo, _revision, signal) {
  if (demo) return (await import('./sample-data.js')).sampleRecommendations(params);
  const { q, ...filters } = params;
  return request('/recommendations', signal, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q, filters }),
  });
}

export async function getSummary(demo, _revision, signal) {
  if (demo) return (await import('./sample-data.js')).sampleSummary();
  return (await request('/discovery/summary', signal)).data;
}

export async function getDiscovery(params, demo, _revision, signal) {
  if (demo) return (await import('./sample-data.js')).sampleDiscovery(params);
  const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== '' && value != null));
  return request(`/discovery?${query}`, signal);
}

export async function getRecord(kind, id, demo, signal) {
  if (demo) {
    const data = await import('./sample-data.js');
    const record = (kind === 'researchers' ? data.sampleResearchers : data.samplePublications).find((item) => item._id === id);
    if (!record) throw new Error('This sample record is unavailable.');
    return record;
  }
  return (await request(`/${kind}/${encodeURIComponent(id)}`, signal)).data;
}

export function externalUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

export function publicationLink(record) {
  if (!record) return null;
  const provided = externalUrl(record.publicationUrl);
  if (provided) return provided;
  const doi = typeof record.externalIds?.doi === 'string' ? record.externalIds.doi.trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, '') : '';
  if (/^10\.\d{4,9}\/\S+$/i.test(doi)) return `https://doi.org/${doi.split('/').map(encodeURIComponent).join('/')}`;
  return externalUrl(record.sourceUrl);
}
