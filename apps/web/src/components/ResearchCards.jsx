import Icon from './Icon';
import { publicationLink } from '../services/research-api';
import { flyToTarget } from '../services/motion';

export const publicationType = (type) => ({ 'journal-article': 'Journal article', 'conference-paper': 'Conference paper', 'book-chapter': 'Book chapter', preprint: 'Preprint', thesis: 'Thesis', other: 'Publication' }[type] || 'Publication');
export const affiliationFor = (record) => record.affiliations?.find((a) => a.isCurrent !== false) || record.affiliations?.[0];

const MATCH_FIELDS = { name: 'name', researchInterests: 'research interests', biography: 'biography',
  'affiliations.department': 'department', 'affiliations.institution': 'institution', title: 'title', keywords: 'keywords',
  'authors.name': 'author names', abstract: 'abstract', 'venue.name': 'venue', 'externalIds.doi': 'DOI',
  'externalIds.orcid': 'ORCID', 'externalIds.openAlex': 'OpenAlex ID' };

export function MatchExplanation({ record }) {
  const fields = (record?.searchMatch?.matchedFields || []).map((field) => MATCH_FIELDS[field] || field);
  const count = record?.matchedPublicationCount || 0;
  if (!fields.length && !count) return null;
  const score = record.searchMatch?.score;
  return <p className="muted" title={score > 0 ? `Relevance score: ${score}. Ranking points, not a percentage.` : undefined}>
    {fields.length > 0 && `${record.searchMatch?.exactMatch ? 'Exact match' : 'Matched'} in ${fields.join(', ')}.`}
    {count > 0 && ` ${count.toLocaleString()} matching ${count === 1 ? 'publication' : 'publications'}.`}
  </p>;
}

export function Tags({ values = [], limit = 5 }) {
  if (!values.length) return null;
  return <div className="topic-tags">{values.slice(0, limit).map((value, index) => <span key={`${value}-${index}`}>{value}</span>)}{values.length > limit && <span className="tag-extra" title={values.slice(limit).join(', ')}>+{values.length - limit}</span>}</div>;
}

export function SaveButton({ kind, record, saved, iconOnly = false }) {
  const active = saved.has(kind, record._id);
  const name = record.name || record.title;
  function toggle(event) {
    if (saved.toggle(kind, record) && !active) flyToTarget(event.currentTarget, () => document.querySelector('[data-save-target] > svg'), { paper: true });
  }
  return <button className={`save-button ${active ? 'is-saved' : ''} ${iconOnly ? 'icon-only' : ''}`} aria-label={`${active ? 'Unsave' : 'Save'} ${name}`} aria-pressed={active} onClick={toggle}><Icon name={active ? 'check' : 'bookmark'} size={17}/>{!iconOnly && (active ? 'Saved' : 'Save')}</button>;
}

export function ResearcherCard({ record, saved, selected, onCompare, onOpen, compareFull = false, showMatches = false }) {
  const affiliation = affiliationFor(record);
  const initials = record.name.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join('');
  const evidence = showMatches ? record.matchingPublications?.[0] : null;
  const preview = evidence || record.latestPublication;
  const searchContext = showMatches ? record : null;
  return <article className="research-card" data-record-key={`researchers-${record._id}`}>
    <div className="research-card-top">
      <div className="identity"><div className="avatar" aria-hidden="true">{initials}</div><div className="identity-text"><h2><button className="title-link" onClick={(event) => onOpen('researchers', record._id, event, searchContext)}>{record.name}</button></h2><p className="affiliation">{affiliation?.department || affiliation?.institution || 'Affiliation unavailable'}</p>{affiliation?.department && <p className="institution">{affiliation.institution}</p>}</div></div>
      <SaveButton kind="researchers" record={record} saved={saved}/>
    </div>
    <Tags values={record.researchInterests}/>
    {showMatches && <MatchExplanation record={record}/>}
    {preview ? <div className="latest-publication"><div className="small-label"><Icon name="paper" size={14}/>{evidence ? 'Top matching publication' : 'Latest in this collection'}{preview.year ? <span>· {preview.year}</span> : null}</div><button className="paper-link" onClick={(event) => onOpen('publications', preview._id, event, evidence || null)}>{preview.title}<Icon name="arrow" size={16}/></button></div> : <p className="no-publications">{typeof record.publicationCount === 'number' ? 'No publications linked yet.' : 'Open the profile to explore publications.'}</p>}
    <div className="card-footer"><div className="card-actions"><button className="button button-light" onClick={(event) => onOpen('researchers', record._id, event, searchContext)}>View profile<Icon name="arrow" size={15}/></button><button className={`button button-quiet ${selected ? 'selected' : ''}`} aria-label={`${selected ? 'Remove' : 'Compare'} ${record.name}${selected ? ' from comparison' : ''}`} aria-pressed={selected} disabled={compareFull && !selected} onClick={(event) => onCompare(record, event)}><Icon name={selected ? 'check' : 'compare'} size={16}/>{selected ? 'Selected' : 'Compare'}</button></div>{typeof record.publicationCount === 'number' && <span className="collection-count" title="Stored publication records, not a complete career or guaranteed distinct-work count">{record.publicationCount.toLocaleString()} {record.publicationCount === 1 ? 'paper' : 'papers'} in collection</span>}</div>
  </article>;
}

export function PublicationCard({ record, saved, onOpen, showMatches = false }) {
  const sourceUrl = publicationLink(record);
  const searchContext = showMatches ? record : null;
  return <article className="research-card publication-card" data-record-key={`publications-${record._id}`}>
    <div className="publication-meta"><span><Icon name="paper" size={15}/>{publicationType(record.type)}</span><span>{record.year || 'Year unavailable'}</span></div>
    <div className="publication-heading"><h2><button className="title-link" onClick={(event) => onOpen('publications', record._id, event, searchContext)}>{record.title}</button></h2><SaveButton kind="publications" record={record} saved={saved} iconOnly/></div>
    <div className="author-list">{record.authors?.slice(0, 4).map((author, index) => <span key={index}>{index > 0 && <span className="author-separator">, </span>}{author.researcherId ? <button className="inline-link" onClick={(event) => onOpen('researchers', author.researcherId, event)}>{author.name}</button> : author.name}</span>)}{record.authors?.length > 4 && <span> +{record.authors.length - 4} authors</span>}</div>
    {record.venue?.name && <p className="venue">{record.venue.name}</p>}
    <Tags values={record.keywords}/>
    {showMatches && <MatchExplanation record={record}/>}
    <div className="card-footer">
      <div className="card-actions">
        <button className="button button-light" onClick={(event) => onOpen('publications', record._id, event, searchContext)}>Read publication<Icon name="arrow" size={15}/></button>
        {sourceUrl && <a className="button button-primary" href={sourceUrl} target="_blank" rel="noopener noreferrer">Open paper<Icon name="external" size={15}/><span className="sr-only"> (opens in a new tab)</span></a>}
      </div>
    </div>
  </article>;
}

export function LoadingCards() {
  return <div role="status" aria-label="Loading research" className="loading-cards">{[0, 1, 2].map((item) => <div className="research-card skeleton-card" key={item} aria-hidden="true"><div className="skeleton skeleton-title"/><div className="skeleton skeleton-line"/><div className="skeleton skeleton-tags"/><div className="skeleton skeleton-line"/></div>)}</div>;
}

export function EmptyState({ icon = 'search', title, children, action }) {
  return <div className="empty-state"><div className="empty-icon"><Icon name={icon} size={28}/></div><h2>{title}</h2><div className="empty-description">{children}</div>{action}</div>;
}
