import { normaliseDoi } from './otago-normalize.mjs';

export function crossrefAbstractText(value) {
  if (typeof value !== 'string' || value.length > 250000) return '';
  if (/<!DOCTYPE|<!ENTITY|<(?:\w+:)?(?:math|tex-math)\b/i.test(value)) return '';
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  let invalidEntity = false;
  let text = value
    .replace(/<!--[^]*?-->/g, '')
    .replace(/<(?:script|style)\b[^>]*>[^]*?<\/(?:script|style)\s*>/gi, '')
    .replace(/<!\[CDATA\[([^]*?)\]\]>/g, '$1')
    .replace(/<\/?(?:[\w-]+:)?(?:p|title|sec|br|list-item)\b[^>]*>/gi, ' ')
    .replace(/<\/?[A-Za-z][^>]*>/g, '');
  text = text.replace(/&(#x[\da-f]+|#\d+|[a-z][\da-z]*);/gi, (match, name) => {
    if (name.startsWith('#')) {
      const code = name[1].toLowerCase() === 'x'
        ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      if (code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        invalidEntity = true;
        return '';
      }
      return String.fromCodePoint(code);
    }
    if (!Object.hasOwn(entities, name.toLowerCase())) {
      invalidEntity = true;
      return match;
    }
    return entities[name.toLowerCase()];
  });
  if (invalidEntity) return '';
  text = text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}

function fullDate(value) {
  const parts = value?.['date-parts']?.[0];
  if (!Array.isArray(parts) || parts.length !== 3 || !parts.every(Number.isInteger)) return undefined;
  const [year, month, day] = parts;
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const date = new Date(`${iso}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === iso ? date : undefined;
}

function compatibleType(publication, record) {
  if (!record.type) return true;
  const equivalent = {
    'journal-article': 'journal-article',
    'proceedings-article': 'conference-paper',
    'book-chapter': 'book-chapter',
  }[record.type];
  if (equivalent) return equivalent === publication.type;
  return publication.type === 'preprint' && record.type === 'posted-content' && record.subtype === 'preprint';
}
export async function enrichFromCrossref(publication, cachedFetch) {
  const unchanged = (skippedReason, sourceUrl) => ({
    publication, changedFields: [], skippedReason, ...(sourceUrl ? { sourceUrl } : {}),
  });
  const doi = normaliseDoi(publication.externalIds?.doi);
  if (!doi) return unchanged('missing-doi');
  const needsAbstract = !publication.abstract?.trim();
  const needsPublisher = !publication.venue?.publisher?.trim();
  const needsDate = !publication.publicationDate;
  if (!needsAbstract && !needsPublisher && !needsDate) return unchanged('no-missing-fields');
  const sourceUrl = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
  let response;
  try {
    response = await cachedFetch(sourceUrl);
  } catch {
    return unchanged('fetch-failed', sourceUrl);
  }
  const record = response?.message;
  if (!record || normaliseDoi(record.DOI) !== doi) return unchanged('doi-mismatch', sourceUrl);
  if (!compatibleType(publication, record)) return unchanged('type-conflict', sourceUrl);
  const result = { ...publication, venue: { ...publication.venue } };
  const changedFields = [];
  if (needsAbstract) {
    const abstract = crossrefAbstractText(record.abstract);
    if (abstract) {
      result.abstract = abstract;
      changedFields.push('abstract');
    }
  }
  if (needsPublisher && typeof record.publisher === 'string' && record.publisher.trim()) {
    result.venue.publisher = record.publisher.trim();
    changedFields.push('venue.publisher');
  }
  if (needsDate) {
    for (const field of ['published', 'published-online', 'published-print', 'issued']) {
      const date = fullDate(record[field]);
      if (!date || (publication.year && date.getUTCFullYear() !== publication.year)) continue;
      result.publicationDate = date;
      changedFields.push('publicationDate');
      break;
    }
  }
  return { publication: result, changedFields, sourceUrl };
}
