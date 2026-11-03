import { useLayoutEffect, useRef, useState } from 'react';
import Icon from './Icon';
import { affiliationFor, EmptyState, MatchExplanation, PublicationCard, SaveButton, Tags, publicationType } from './ResearchCards';
import { getDiscovery, getRecord, externalUrl, publicationLink } from '../services/research-api';
import { useRequest } from '../hooks/use-request';
import { flyToTarget, initialsFor, panelOrigin, play, reducedMotion, sharedTitle } from '../services/motion';

export function Dialog({ title, onClose, children, wide = false, origin, ready = true }) {
  const ref = useRef(null);
  const closeTimer = useRef(null);
  const closing = useRef(false);
  const onCloseRef = useRef(onClose);
  const [isClosing, setIsClosing] = useState(false);
  const effects = useRef([]);
  const openedAt = useRef(0);
  const linked = Boolean(origin || wide);
  onCloseRef.current = onClose;
  function stopEffects() { effects.current.forEach(stop => stop()); effects.current = []; }

  function requestClose() {
    if (closing.current) return;
    closing.current = true;
    if (reducedMotion()) {
      onCloseRef.current();
      return;
    }
    stopEffects();
    ref.current.dataset.return = String(Boolean(panelOrigin(ref.current, origin, true)));
    const cancelTitle = ready && sharedTitle(origin, ref.current.querySelector('.detail-title'), true);
    if (cancelTitle) effects.current.push(cancelTitle);
    setIsClosing(true);
    const duration = Number.parseFloat(getComputedStyle(ref.current).getPropertyValue('--motion-dismiss')) || 420;
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      onCloseRef.current();
    }, duration);
  }

  useLayoutEffect(() => {
    const dialog = ref.current;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    dialog.showModal(); document.body.style.overflow = 'hidden';
    openedAt.current = performance.now();
    if (linked && !reducedMotion()) {
      if (wide) {
        dialog.querySelectorAll('[data-compare-person]').forEach((column, index) => {
          const avatar = dialog.querySelector(`[data-comparison-avatar="${CSS.escape(column.dataset.comparePerson)}"]`);
          const source = document.querySelector(`[data-compare-avatar="${CSS.escape(column.dataset.comparePerson)}"]`);
          if (source && avatar) {
            const cancelFlight = flyToTarget(source, () => avatar, { label: avatar.textContent, duration: 820 + index * 65, targetRect: avatar.getBoundingClientRect() });
            if (cancelFlight) effects.current.push(cancelFlight);
          }
          const animation = play(column, [{ opacity: 0, transform: 'translateY(32px) scale(.94)', borderRadius: '28px' }, { opacity: 1, transform: 'translateY(0) scale(1)', borderRadius: '10px' }], { duration: 760, delay: index * 65, fill: 'backwards' });
          if (animation) effects.current.push(() => animation.cancel());
        });
        const panel = play(dialog, [{ opacity: 0 }, { opacity: 1 }], { duration: 760 });
        if (panel) effects.current.push(() => panel.cancel());
      }
    }
    return () => {
      stopEffects();
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, []);
  useLayoutEffect(() => {
    if (!ready || !origin || closing.current || reducedMotion()) return;
    stopEffects();
    const cancelTitle = sharedTitle(origin, ref.current.querySelector('.detail-title'));
    if (cancelTitle) effects.current.push(cancelTitle);
    const from = performance.now() - openedAt.current < 250 && panelOrigin(ref.current, origin);
    if (from) {
      const panel = play(ref.current, [{ opacity: .12, transform: from }, { opacity: 1, transform: 'translate(0, 0) scale(1)' }], { duration: 760 });
      if (panel) effects.current.push(() => panel.cancel());
    }
    const animation = play(ref.current.querySelector('.dialog-content'), [{ opacity: 0 }, { opacity: 1 }], { duration: 760 });
    if (animation) effects.current.push(() => animation.cancel());
  }, [ready]);
  return <dialog ref={ref} className={`research-dialog ${wide ? 'dialog-wide' : ''} ${linked ? 'motion-linked' : ''} ${isClosing ? 'is-closing' : ''}`} data-loading={!ready} aria-label={title} onCancel={(event) => { event.preventDefault(); requestClose(); }} onClick={(event) => { if (event.target === event.currentTarget) requestClose(); }}><div className="dialog-content"><div className="dialog-top"><span className="eyebrow">{title}</span><button className="button button-icon" aria-label="Close details" onClick={requestClose}><Icon name="close"/></button></div>{children}</div></dialog>;
}

function ResearcherPublications({ id, demo, saved, onOpen }) {
  const [page, setPage] = useState(1);
  const request = useRequest(getDiscovery, [{ kind: 'publications', researcher: id, sort: 'newest', page, limit: 6 }, demo, 0]);
  return <section className="profile-publications"><h3>Publications in this collection{request.data && <span className="count-pill">{request.data.total}</span>}</h3>
    {request.loading ? <p className="muted" role="status">Loading publications…</p> : request.error ? <p role="alert">{request.error.message}</p> : request.data.data.length ? <>{request.data.data.map((item) => <PublicationCard key={item._id} record={item} saved={saved} onOpen={onOpen}/>)}{request.data.pages > 1 && <div className="pagination"><button className="button button-light" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</button><span>{page} / {request.data.pages}</span><button className="button button-light" disabled={page >= request.data.pages} onClick={() => setPage(page + 1)}>Next</button></div>}</> : <p className="muted">No publications are linked to this profile yet.</p>}
  </section>;
}

export function RecordDialog({ kind, id, demo, saved, onOpen, onClose, onCompare, selected, compareFull, origin, searchContext }) {
  const request = useRequest(getRecord, [kind, id, demo]);
  const record = request.data;
  const affiliation = record && kind === 'researchers' ? affiliationFor(record) : null;
  const source = kind === 'researchers' ? externalUrl(record?.profileUrl) : publicationLink(record);
  return <Dialog title={kind === 'researchers' ? 'Researcher profile' : 'Publication details'} onClose={onClose} origin={origin} ready={!request.loading}>
    <h2 className="detail-title">{record?.name || record?.title || origin?.text || (kind === 'researchers' ? 'Researcher profile' : 'Publication details')}</h2>
    {request.loading ? <p className="dialog-loading" role="status">Loading details…</p> : request.error ? <EmptyState icon="info" title="Unable to open this record">{request.error.message}</EmptyState> : <>
      {kind === 'researchers' ? <p className="detail-subtitle">{[affiliation?.department, affiliation?.institution].filter(Boolean).join(' · ') || 'Affiliation unavailable'}</p> : <><p className="detail-subtitle">{[record.year, publicationType(record.type), record.venue?.name].filter(Boolean).join(' · ')}</p><div className="author-list detail-authors">{record.authors?.map((a, i) => <span key={i}>{i > 0 && ', '}{a.researcherId ? <button className="inline-link" onClick={(event) => onOpen('researchers', a.researcherId, event)}>{a.name}</button> : a.name}</span>)}</div></>}
      <div className="detail-actions"><SaveButton kind={kind} record={record} saved={saved}/>{kind === 'researchers' && <button className="button button-light" aria-pressed={selected} disabled={compareFull && !selected} onClick={(event) => onCompare(record, event)}><Icon name={selected ? 'check' : 'compare'} size={16}/>{selected ? 'Selected for comparison' : 'Add to comparison'}</button>}{source && <a href={source} target="_blank" rel="noopener noreferrer" className="button button-quiet">{kind === 'researchers' ? 'Official profile' : 'View source'}<Icon name="external" size={15}/></a>}</div>
      {searchContext && <section className="detail-section"><h3>Why this matched</h3><MatchExplanation record={searchContext}/>{searchContext.matchingPublications?.slice(0, 3).map((paper) => <div className="latest-publication" key={paper._id}><div className="small-label"><Icon name="paper" size={14}/>Matching publication{paper.year ? <span>· {paper.year}</span> : null}</div><button className="paper-link" onClick={(event) => onOpen('publications', paper._id, event, paper)}>{paper.title}<Icon name="arrow" size={16}/></button><MatchExplanation record={paper}/></div>)}</section>}
      <section className="detail-section"><h3>{kind === 'researchers' ? 'Research overview' : 'Abstract'}</h3><p className="long-text">{kind === 'researchers' ? record.biography || 'A biography is not available for this researcher yet.' : record.abstract || 'An abstract is not available for this publication.'}</p><Tags values={kind === 'researchers' ? record.researchInterests : record.keywords} limit={100}/></section>
      {kind === 'researchers' && <ResearcherPublications id={id} demo={demo} saved={saved} onOpen={onOpen}/>}
      {record.lastSyncedAt && <p className="data-note">Collected {new Date(record.lastSyncedAt).toLocaleDateString('en-NZ')}. Source details may have changed.</p>}
    </>}
  </Dialog>;
}

export function CompareDialog({ records, saved, onClose, onOpen }) {
  return <Dialog title="Compare researchers" wide onClose={onClose}><h2 className="detail-title">Find your research direction.</h2><p className="detail-subtitle">Explore interests and publication evidence side by side.</p><div className="comparison-grid">{records.map((record) => <article className="comparison-person" key={record._id} data-compare-person={record._id}><div className="comparison-person-identity"><span className="avatar" aria-hidden="true" data-comparison-avatar={record._id}>{initialsFor(record.name)}</span><h3>{record.name}</h3></div><p className="muted">{affiliationFor(record)?.department || 'Department unavailable'}</p><div className="compare-section"><h4>Research interests</h4>{record.researchInterests?.length ? <Tags values={record.researchInterests} limit={12}/> : <p className="muted">Not listed</p>}</div><div className="compare-section"><h4>Research overview</h4><p className="comparison-bio">{record.biography || 'Biography unavailable.'}</p></div><div className="compare-section"><h4>Publication evidence</h4><p>{typeof record.publicationCount === 'number' ? `${record.publicationCount} papers in this collection` : 'Open the profile for publications.'}</p>{record.latestPublication && <p className="muted">{record.latestPublication.title}</p>}</div><div className="card-actions"><SaveButton kind="researchers" record={record} saved={saved}/><button className="button button-quiet" onClick={(event) => onOpen('researchers', record._id, event)}>View profile<Icon name="arrow" size={15}/></button></div></article>)}</div></Dialog>;
}
