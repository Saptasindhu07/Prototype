import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Icon from '../components/Icon';
import MotionList from '../components/MotionList';
import { EmptyState, LoadingCards } from '../components/ResearchCards';
import { clearedFilters, defaultSort } from '../services/explorer-state';
import AIRecommendations from '../features/recommendations/AIRecommendations';

export default function ExplorePage({ location, navigate, summary, request, departments, renderCard, refresh, pageSize, onOpen }) {
  const { section, kind, q, match, department, researcher, year, yearFrom, yearTo, type, sort, page, demo } = location;
  const [draft, setDraft] = useState(q);
  const previous = useRef(null);
  const collection = `${demo}-${kind}`;
  useLayoutEffect(() => {
    if (!request.loading) previous.current = { collection, data: request.data };
  }, [collection, request.loading, request.data]);
  const displayData = request.loading && previous.current?.collection === collection ? previous.current.data : request.data;
  useEffect(() => setDraft(q), [q]);
  const filtered = Boolean(q || department || researcher || year || yearFrom || yearTo || type);
  const resetFilters = () => navigate({ ...clearedFilters, sort: defaultSort(kind, '') });
  const years = [...new Set([...(summary.data?.years || []), ...[year, yearFrom, yearTo].filter(Boolean).map(Number)])].sort((a, b) => b - a);
  const range = Boolean(yearFrom || yearTo);
  const inputError = [400, 422].includes(request.error?.status);
  const errorTitle = inputError ? 'Check your search.' : request.error?.status === 503 ? 'Search is temporarily unavailable.' : 'Let’s reconnect to the collection.';
  function changeKind(value) {
    navigate({ kind: value, ...(section !== 'explore' ? { section: value } : {}) });
  }
  function changeYear(value) {
    navigate(value === 'range' ? { year: '', yearFrom: String(years.at(-1)), yearTo: '' } : { year: value, yearFrom: '', yearTo: '' });
  }
  return <>
    <form className="search-bar" role="search" data-loading={request.loading} aria-busy={request.loading} onSubmit={(event) => { event.preventDefault(); navigate({ q: draft.trim() }); }}>
      <span className="search-signal" aria-hidden="true"><span/></span><Icon name="search" size={22}/><label className="sr-only" htmlFor="research-search">Search {kind === 'researchers' ? 'names, research interests, linked paper topics or ORCID' : 'publication titles, abstracts, authors or DOI'}</label>
      <input id="research-search" type="search" maxLength={160} aria-describedby="search-hint" placeholder={kind === 'researchers' ? 'Search a name, topic or ORCID…' : 'Search a title, keyword, author or DOI…'} value={draft} onChange={(event) => setDraft(event.target.value)}/>
      <span id="search-hint" className="sr-only">Use double quotes for an exact phrase. Up to 8 distinct words or phrases. Matching is literal, without typo correction.</span>
      <button className="button button-primary" type="submit">Search<Icon name="arrow" size={16}/></button>
    </form>
    <div className="filter-row">
      <label>Academic unit<select aria-label="Academic unit" value={department} onChange={(event) => navigate({ department: event.target.value })}><option value="">All academic units</option>{departments.map((name) => <option key={name}>{name}</option>)}</select></label>
      <label>Match<select aria-label="Match terms" value={match} onChange={(event) => navigate({ match: event.target.value })}><option value="all">All terms</option><option value="any">Any term</option></select></label>
      <label>Year<select aria-label="Year" value={range ? 'range' : year} onChange={(event) => changeYear(event.target.value)}><option value="">All years</option><option value="range" disabled={!years.length}>Year range</option>{years.map((value) => <option key={value}>{value}</option>)}</select></label>
      {range && <><label>From<select aria-label="Year from" value={yearFrom} onChange={(event) => navigate({ yearFrom: event.target.value })}><option value="">Any start</option>{years.map((value) => <option key={value} disabled={Boolean(yearTo) && value > Number(yearTo)}>{value}</option>)}</select></label><label>To<select aria-label="Year to" value={yearTo} onChange={(event) => navigate({ yearTo: event.target.value })}><option value="">Any end</option>{years.map((value) => <option key={value} disabled={Boolean(yearFrom) && value < Number(yearFrom)}>{value}</option>)}</select></label></>}
      <label>Publication type<select aria-label="Publication type" value={type} onChange={(event) => navigate({ type: event.target.value })}><option value="">All types</option><option value="journal-article">Journal article</option><option value="conference-paper">Conference paper</option><option value="preprint">Preprint</option><option value="book-chapter">Book chapter</option><option value="thesis">Thesis</option><option value="other">Other</option></select></label>
      <label className="sort-filter">Sort by<select aria-label="Sort by" value={sort} onChange={(event) => navigate({ sort: event.target.value })}><option value="relevance">Most relevant</option>{kind === 'researchers' ? <><option value="name">Name A–Z</option><option value="recent">Recently added</option></> : <><option value="newest">Newest published</option><option value="oldest">Oldest published</option><option value="title">Title A–Z</option></>}</select></label>
    </div>
    {filtered && <div className="active-filters"><span>Filtered by</span>{q && <button onClick={() => navigate({ q: '' })}>“{q}”<Icon name="close" size={13}/><span className="sr-only">Remove search</span></button>}{q && match === 'any' && <button onClick={() => navigate({ match: 'all' })}>Any term<Icon name="close" size={13}/><span className="sr-only">Require all terms</span></button>}{department && <button onClick={() => navigate({ department: '' })}>{department}<Icon name="close" size={13}/><span className="sr-only">Remove department</span></button>}{researcher && <button title={researcher} onClick={() => navigate({ researcher: '' })}>Selected researcher<Icon name="close" size={13}/><span className="sr-only">Remove researcher</span></button>}{year && <button onClick={() => navigate({ year: '' })}>{year}<Icon name="close" size={13}/><span className="sr-only">Remove year</span></button>}{range && <button onClick={() => navigate({ yearFrom: '', yearTo: '' })}>{yearFrom || 'Any start'}–{yearTo || 'Any end'}<Icon name="close" size={13}/><span className="sr-only">Remove year range</span></button>}{type && <button onClick={() => navigate({ type: '' })}>{type.replaceAll('-', ' ')}<Icon name="close" size={13}/><span className="sr-only">Remove type</span></button>}<button className="clear-filters" onClick={resetFilters}>Clear all</button></div>}
    <div className="results-toolbar"><div className="result-tabs" data-kind={kind} role="group" aria-label="Result type"><button aria-pressed={kind === 'researchers'} onClick={() => changeKind('researchers')}><Icon name="people" size={17}/>Researchers{summary.data && <span>{summary.data.researchers.toLocaleString()}</span>}</button><button aria-pressed={kind === 'publications'} onClick={() => changeKind('publications')}><Icon name="paper" size={17}/>Publications{summary.data && <span>{summary.data.publications.toLocaleString()}</span>}</button></div><div className="results-actions"><span className="results-count" role="status">{request.loading ? 'Loading…' : request.data ? `${request.data.total.toLocaleString()} ${filtered ? 'results' : kind}` : ''}</span><AIRecommendations location={location} onOpen={onOpen}/></div></div>
    {kind === 'publications' && department && <p className="filter-note">Department filters use linked researchers’ current affiliations.</p>}
    {kind === 'researchers' && (year || range || type) && <p className="filter-note">These filters require a linked publication that matches the selected years, type and search.</p>}
    {request.data?.search?.duplicatesCollapsed > 0 && <p className="filter-note">{request.data.search.duplicatesCollapsed} duplicate {request.data.search.duplicatesCollapsed === 1 ? 'representation is' : 'representations are'} grouped in these results. Collection counts still include the stored records.</p>}
    <MotionList label={`${kind} results`} busy={request.loading} layoutKey={`${collection}:${displayData?.data.map(record => record._id).join(',') || 'empty'}`}>
      {request.loading && !displayData ? <LoadingCards/> : request.error ? <EmptyState icon="info" title={errorTitle} action={<div className="empty-actions">{inputError ? <button className="button button-light" onClick={resetFilters}>Clear filters<Icon name="arrow" size={16}/></button> : <><button className="button button-primary" onClick={refresh}>Try again<Icon name="refresh" size={16}/></button>{!demo && <button className="button button-light" onClick={() => navigate({ demo: true })}>Try sample view</button>}</>}</div>}><p>{request.error.message}</p></EmptyState> : displayData?.data.length ? displayData.data.map((record) => renderCard(record)) : <EmptyState icon={filtered ? 'search' : 'book'} title={filtered ? 'No results for these filters.' : 'The collection starts here.'} action={filtered ? <button className="button button-light" onClick={resetFilters}>Clear filters<Icon name="arrow" size={16}/></button> : <div className="empty-actions"><button className="button button-primary" onClick={refresh}>Refresh collection<Icon name="refresh" size={16}/></button>{!demo && <button className="button button-light" onClick={() => navigate({ demo: true })}>Try sample view<Icon name="arrow" size={16}/></button>}</div>}><p>{filtered ? 'Try another keyword, Any term matching, or a broader year range.' : 'Research profiles and publications will appear as records are added. You can explore the layout with a clearly labelled sample collection.'}</p></EmptyState>}
    </MotionList>
    {request.data?.pages > 1 && request.data.data.length > 0 && <nav className="pagination" aria-label="Results pages"><span>Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, request.data.total)} of {request.data.total.toLocaleString()}</span><div><button className="button button-light" disabled={page <= 1} onClick={() => navigate({ page: page - 1 })}>Previous</button><span className="page-number">{page} / {request.data.pages}</span><button className="button button-light" disabled={page >= request.data.pages} onClick={() => navigate({ page: page + 1 })}>Next<Icon name="arrow" size={15}/></button></div></nav>}
    {request.data?.total > 0 && !request.data.data.length && page > 1 && <button className="button button-light" onClick={() => navigate({ page: 1 })}>Return to the first page</button>}
  </>;
}
