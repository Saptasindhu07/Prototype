import { useEffect, useState } from 'react';

export function savedSnapshot(record) {
  const { abstract, searchMatch, matchingPublications, matchedPublicationCount, duplicateRecordIds, ...snapshot } = record;
  return snapshot;
}

function read(key) {
  try {
    const records = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(records) ? records.filter((item) => item && ['researchers', 'publications'].includes(item.kind)
      && typeof item.record?._id === 'string' && typeof (item.record.name || item.record.title) === 'string') : [];
  } catch { return []; }
}

export function useSavedRecords(demo) {
  const key = `research-atlas:saved:${demo ? 'sample' : 'live'}:v1`;
  const [store, setStore] = useState(() => ({ key, items: read(key) }));
  const [error, setError] = useState('');
  const items = store.key === key ? store.items : read(key);
  useEffect(() => {
    setStore({ key, items: read(key) }); setError('');
    const sync = (event) => { if (event.key === key || event.key === null) setStore({ key, items: read(key) }); };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, [key]);
  function toggle(kind, record) {
    const exists = items.some((item) => item.kind === kind && item.record._id === record._id);
    const snapshot = savedSnapshot(record);
    const next = exists ? items.filter((item) => !(item.kind === kind && item.record._id === record._id)) : [...items, { kind, record: snapshot }];
    try {
      localStorage.setItem(key, JSON.stringify(next)); setStore({ key, items: next }); setError('');
      return true;
    } catch { setError('Your browser could not save this item. Check that local storage is available.'); return false; }
  }
  return { items, toggle, error, has: (kind, id) => items.some((item) => item.kind === kind && item.record._id === id) };
}
