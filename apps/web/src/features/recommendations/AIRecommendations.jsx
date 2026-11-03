import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from '../../components/Icon';
import { useRequest } from '../../hooks/use-request';
import { getRecommendations, publicationLink } from '../../services/research-api';
import { initialsFor } from '../../services/motion';
import './recommendations.css';

function affiliation(person) {
  return person.affiliations?.find(a => a.isCurrent !== false)?.department || 'Researcher in this collection';
}

function RecommendationPanel({ params, demo, onClose, onOpen, triggerRef }) {
  const dialogRef = useRef(null);
  const [revision, setRevision] = useState(0);
  const [selectedId, setSelectedId] = useState(null);
  const request = useRequest(getRecommendations, [params, demo, revision]);
  const recommendations = request.data?.data?.recommendations || [];
  const selected = recommendations.find(item => item.researcher._id === selectedId) || recommendations[0];
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    dialog.show();
    dialog.querySelector('[data-ai-close]').focus({ preventScroll: true });
    function escape(event) {
      if (event.key === 'Escape' && !document.querySelector('dialog:modal')) { event.preventDefault(); onClose(); }
    }
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('keydown', escape);
      const restoreFocus = dialog.contains(document.activeElement) || document.activeElement === document.body;
      dialog.close();
      if (restoreFocus && !document.querySelector('dialog:modal')) triggerRef.current?.focus({ preventScroll: true });
    };
  }, []);

  function openPaper(paper, event) {
    triggerRef.current?.focus({ preventScroll: true });
    onOpen('publications', paper._id, event);
    onClose();
  }

  return createPortal(<dialog ref={dialogRef} id="ai-research-trail" className="ai-trail" aria-labelledby="ai-trail-title" aria-describedby="ai-trail-scope">
    <header className="ai-trail-header"><div><div className="ai-trail-eyebrow"><Icon name="sparkles" size={14}/>{demo ? 'SAMPLE RESEARCH SHORTLIST' : 'AI RECOMMENDATIONS'}</div><h2 id="ai-trail-title">Your research shortlist.</h2><p>Research fits for <span className="ai-query">“{params.q}”</span></p></div><button className="button button-icon" data-ai-close onClick={onClose} aria-label="Close AI recommendations"><Icon name="close" size={20}/></button></header>
    <div className="ai-trail-body" aria-busy={request.loading}>
      {demo && <p className="ai-sample-note">Sample layout only. These fictional suggestions are not model-ranked for your query.</p>}
      {request.loading ? <div className="ai-loading" role="status"><span className="ai-loading-mark" aria-hidden="true"><Icon name="sparkles" size={22}/></span><h3>Finding research connections…</h3><p>Matching your topic with publications and the people behind them.</p><div className="ai-loading-cards" aria-hidden="true"><span/><span/><span/></div></div>
        : request.error ? <div className="ai-feedback" role="alert"><Icon name="info" size={24}/><h3>{request.error.status === 503 ? 'Recommendations aren’t available yet.' : 'We couldn’t load recommendations.'}</h3><p>{request.error.message}</p><button className="button button-light" onClick={() => setRevision(value => value + 1)}>Try again<Icon name="refresh" size={15}/></button></div>
        : !selected ? <div className="ai-feedback" role="status"><Icon name="search" size={24}/><h3>No linked researchers found.</h3><p>Try a broader topic or fewer filters. Papers without a verified researcher link cannot produce a researcher suggestion.</p></div>
        : <><div className="ai-professor-grid" role="group" aria-label="Suggested researchers">{recommendations.map(item => <button key={item.researcher._id} className={`ai-professor-card ${selected.researcher._id === item.researcher._id ? 'is-selected' : ''}`} aria-pressed={selected.researcher._id === item.researcher._id} onClick={() => setSelectedId(item.researcher._id)}><span className="ai-person-top"><span className="ai-avatar">{initialsFor(item.researcher.name)}</span><span>{selected.researcher._id === item.researcher._id ? <><Icon name="check" size={12}/>Selected</> : 'Explore papers'}</span></span><strong>{item.researcher.name}</strong><span className="ai-affiliation">{affiliation(item.researcher)}</span></button>)}</div>
          <div className="ai-evidence" key={selected.researcher._id} aria-live="polite"><section className="ai-reason"><div className="ai-trail-eyebrow">WHY THIS RESEARCHER</div><h3>{selected.researcher.name}</h3><p>{selected.reason}</p><div className="ai-topic-tags">{selected.researcher.researchInterests?.slice(0, 3).map(topic => <span key={topic}>{topic}</span>)}</div></section><section className="ai-paper-list" aria-label={`Supporting papers for ${selected.researcher.name}`}><h3><Icon name="paper" size={15}/>Supporting papers <span>{selected.papers.length}</span></h3>{selected.papers.map(paper => <details className="ai-paper" key={paper._id}><summary><span>{paper.title}<small>{paper.year || 'Year unavailable'}{paper.venue?.name ? ` · ${paper.venue.name}` : ''}</small></span><Icon name="chevron" size={15}/></summary><div className="ai-paper-detail"><p>{paper.abstract || 'No abstract is available for this publication.'}</p><div className="ai-paper-actions"><button className="button button-light" onClick={event => openPaper(paper, event)}>View paper<Icon name="arrow" size={14}/></button>{publicationLink(paper) && <a className="button button-quiet" href={publicationLink(paper)} target="_blank" rel="noopener noreferrer">Source<Icon name="external" size={13}/></a>}</div></div></details>)}</section></div></>}
    </div>
    <footer id="ai-trail-scope" className="ai-trail-footer"><Icon name="info" size={14}/><span>Topic-based research fit within your selected filters. Supervision availability is not verified.</span></footer>
  </dialog>, document.body);
}

export default function AIRecommendations({ location, onOpen }) {
  const { q, department, researcher, year, yearFrom, yearTo, type, demo } = location;
  const params = Object.fromEntries(Object.entries({ q, department, researcher, year, yearFrom, yearTo, type }).filter(([, value]) => value !== '' && value != null));
  const contextKey = JSON.stringify([params, demo]);
  const [openContext, setOpenContext] = useState(null);
  const triggerRef = useRef(null);
  const open = openContext === contextKey;
  useEffect(() => { setOpenContext(null); }, [contextKey]);
  return <><button ref={triggerRef} type="button" className={`ai-recommendation-trigger ${open ? 'is-open' : ''}`} disabled={!q?.trim()} aria-label={q?.trim() ? 'AI Recommendations' : 'AI Recommendations — enter a research topic first'} aria-expanded={open} aria-controls={open ? 'ai-research-trail' : undefined} onClick={() => setOpenContext(open ? null : contextKey)}><Icon name="sparkles" size={15}/>AI Recommendations</button>{open && <RecommendationPanel key={contextKey} params={params} demo={demo} onOpen={onOpen} onClose={() => setOpenContext(null)} triggerRef={triggerRef}/>}</>;
}
