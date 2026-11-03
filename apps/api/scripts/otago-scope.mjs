export function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(+parsed) && parsed.toISOString().slice(0, 10) === value;
}

export function readOtagoScope(environment = process.env, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-NZ', {
    timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).map(part => [part.type, part.value]));
  const collectionDate = `${parts.year}-${parts.month}-${parts.day}`;
  const fromDate = environment.OTAGO_FROM_DATE || '2015-01-01';
  const cutoff = environment.OTAGO_CUTOFF || collectionDate;
  const target = Number(environment.OTAGO_TARGET || 8000);
  if (!Number.isSafeInteger(target) || target < 1 || target > 8000) throw new Error('Target must be 1..8000.');
  if (!isIsoDate(fromDate) || !isIsoDate(cutoff) || fromDate < '1900-01-01'
      || fromDate > cutoff || cutoff > collectionDate) {
    throw new Error('Otago dates must be valid YYYY-MM-DD, ordered, and within 1900 through collection day in Pacific/Auckland.');
  }
  return { fromDate, cutoff, target };
}

export function publicationWithinScope(publication, { fromDate, cutoff }) {
  if (!publication || !Number.isInteger(publication.year)
      || publication.year < Number(fromDate.slice(0, 4))
      || publication.year > Number(cutoff.slice(0, 4))) return false;
  if (publication.publicationDate != null) {
    const date = new Date(publication.publicationDate);
    if (Number.isNaN(+date)) return false;
    const day = date.toISOString().slice(0, 10);
    if (day < fromDate || day > cutoff) return false;
  }
  return true;
}
