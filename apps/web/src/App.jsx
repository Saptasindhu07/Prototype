import { useEffect, useState } from 'react';
import Icon from './components/Icon';
import AmbientBackground from './components/AmbientBackground';
import MotionList from './components/MotionList';
import { captureOrigin, flyToTarget, initialsFor } from './services/motion';
import { EmptyState, PublicationCard, ResearcherCard } from './components/ResearchCards';
import { CompareDialog, RecordDialog } from './components/ResearchDialog';
import ExplorePage from './pages/ExplorePage';
import { useExplorerLocation } from './hooks/use-explorer-location';
import { useSavedRecords } from './hooks/use-saved-records';
import { useRequest } from './hooks/use-request';
import { getDiscovery, getSummary } from './services/research-api';
import { clearedFilters, defaultSort, discoveryParams } from './services/explorer-state';

const NAV = [['explore', 'Explore', 'explore'], ['researchers', 'Researchers', 'people'], ['publications', 'Publications', 'paper'], ['departments', 'Departments', 'building'], ['saved', 'Saved', 'bookmark']];
const DEPARTMENTS = ['School of Computing', 'Mathematics and Statistics', 'Biochemistry', 'Physics', 'Chemistry', 'Microbiology and Immunology', 'Geology', 'Zoology'];
const PAGE_SIZE = 6;

export default function App() {
  const [location, navigate] = useExplorerLocation();
  const { section, kind, q, department, year, yearFrom, yearTo, type, demo } = location;
  const [revision, setRevision] = useState(0);
  const [detail, setDetail] = useState(null);
  const [comparison, setComparison] = useState({ demo, records: [] });
  const [showCompare, setShowCompare] = useState(false);
  const selected = comparison.demo === demo ? comparison.records : [];
  const saved = useSavedRecords(demo);
  const summary = useRequest(getSummary, [demo, revision]);
  const isBrowsing = ['explore', 'researchers', 'publications'].includes(section);
  const request = useRequest(getDiscovery, [discoveryParams(location, PAGE_SIZE), demo, revision], isBrowsing);
  const showMatches = isBrowsing && Boolean(q || year || yearFrom || yearTo || type);
  useEffect(() => { setDetail(null); setShowCompare(false); }, [demo]);
  const refresh = () => setRevision((value) => value + 1);
  const departments = [...new Set([...DEPARTMENTS, ...(summary.data?.departments || []).map((d) => d.name), ...(department ? [department] : [])])];
  const titles = { explore: 'Explore research.', researchers: 'Meet the researchers.', publications: 'Explore the literature.', departments: 'A world of disciplines.', saved: 'Your research shortlist.' };
  const descriptions = { explore: 'Discover people, ideas and publications across the University of Otago.', researchers: 'Get to know the people behind the research. Follow an interest and see where it leads.', publications: 'Find published work, explore its ideas and connect with the researchers behind it.', departments: 'Explore the collection through eight STEM academic units.', saved: 'Keep the people and papers you want to return to, all in one place.' };

  function selectSection(value) {
    const nextKind = value === 'researchers' || value === 'publications' ? value : kind;
    navigate({ ...clearedFilters, section: value, kind: nextKind, sort: defaultSort(nextKind, '') });
  }
  function toggleCompare(record, event) {
    const exists = selected.some((p) => p._id === record._id);
    if (!exists && selected.length >= 3) return;
    if (!exists && event) {
      const source = event.currentTarget.closest('.research-card')?.querySelector('.avatar') || event.currentTarget;
      flyToTarget(source, () => document.querySelector(`[data-compare-avatar="${CSS.escape(record._id)}"]`), { label: initialsFor(record.name) });
    }
    setComparison({ demo, records: exists ? selected.filter((p) => p._id !== record._id) : [...selected, record].slice(0, 3) });
  }
  function openRecord(recordKind, id, event, searchContext = null) { const origin = captureOrigin(event?.currentTarget || document.activeElement); setShowCompare(false); setDetail({ kind: recordKind, id, origin, searchContext }); }
  function card(record, recordKind = kind) {
    return recordKind === 'researchers'
      ? <ResearcherCard key={record._id} record={record} saved={saved} selected={selected.some((p) => p._id === record._id)} compareFull={selected.length === 3} onCompare={toggleCompare} onOpen={openRecord} showMatches={showMatches}/>
      : <PublicationCard key={record._id} record={record} saved={saved} onOpen={openRecord} showMatches={showMatches}/>;
  }

  return <div className="app-shell">
    <AmbientBackground/>
    <a className="skip-link" href="#main-content">Skip to content</a>
    <aside className="sidebar">
      <a className="brand" href="?" onClick={(event) => { event.preventDefault(); selectSection('explore'); }} aria-label="Research Atlas home"><span className="brand-mark"><Icon name="book" size={23}/></span><span>Research<span className="brand-second">Atlas<span className="brand-dot">.</span></span></span></a>
      <div className="workspace-label">OTAGO COLLECTION</div>
      <nav className="main-nav" aria-label="Main navigation" style={{ '--nav-index': NAV.findIndex(([value]) => value === section) }}>{NAV.map(([value, label, icon]) => <button key={value} data-save-target={value === 'saved' ? '' : undefined} className={`nav-item ${section === value ? 'active' : ''}`} aria-current={section === value ? 'page' : undefined} onClick={() => selectSection(value)}><Icon name={icon}/><span>{label}</span>{value === 'saved' && saved.items.length > 0 && <span className="nav-count" key={saved.items.length}>{saved.items.length}</span>}{section === value && <span className="nav-indicator"/>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="collection-emblem"><Icon name="building" size={18}/><span>University of Otago</span></div><p>A place to discover<br/>your next research direction.</p><span className="prototype-label">RESEARCH PROTOTYPE</span></div>
    </aside>
    <div className="app-body">
      <header className="topbar"><div className="breadcrumb">Research Atlas<Icon name="chevron" size={13}/><span>{NAV.find(([value]) => value === section)?.[1]}</span></div><div className="topbar-right"><span className={`connection-label ${demo ? 'sample' : ''}`}><span className="status-dot"/>{demo ? 'Sample collection' : 'Public research collection'}</span><button className="button button-icon refresh-button" aria-label="Refresh collection" onClick={refresh}><Icon key={revision} name="refresh" size={17} className={revision > 0 ? 'refresh-icon-active' : undefined}/></button></div></header>
      <main id="main-content" className="main-content">
        {demo && <div className="sample-banner" role="status"><Icon name="info" size={17}/><span><strong>Sample view.</strong> These are fictional records for trying the interface.</span><button onClick={() => navigate({ demo: false, page: 1 })}>View live collection<Icon name="arrow" size={14}/></button></div>}
        <section className="page-heading" key={section}><div className="eyebrow"><span className="eyebrow-rule"/>{section === 'saved' ? 'YOUR COLLECTION' : 'CURIOSITY STARTS HERE'}</div><h1>{titles[section]}</h1><p>{descriptions[section]}</p></section>
        {saved.error && <div className="inline-error" role="alert">{saved.error}</div>}
        {isBrowsing && <ExplorePage location={location} navigate={navigate} summary={summary} request={request} departments={departments} renderCard={card} refresh={refresh} pageSize={PAGE_SIZE} onOpen={openRecord}/>}
        {section === 'departments' && <><p className="section-caption">COLLECTION SCOPE<span>{departments.length} academic units</span></p>{summary.error && <p className="inline-error" role="alert">Counts are unavailable. Refresh to try again.</p>}<div className="department-grid">{departments.map((name) => <button className="department-card" key={name} onClick={() => navigate({ ...clearedFilters, section: 'researchers', kind: 'researchers', department: name, sort: 'name' })}><span className="department-icon"><Icon name="building" size={22}/></span><h2>{name}</h2><span className="department-card-footer"><span>{summary.loading || summary.error ? 'Browse researchers' : `${summary.data?.departments.find((item) => item.name === name)?.count || 0} researchers in collection`}</span><Icon name="arrow" size={18}/></span></button>)}</div></>}
        {section === 'saved' && <><div className="saved-note"><Icon name="bookmark" size={18}/><span>Saved in this browser. {demo ? 'Sample saves are separate from your live shortlist.' : 'No account needed.'}</span><span className="count-pill">{saved.items.length}</span></div><MotionList label="Saved research" layoutKey={saved.items.map(({ kind: recordKind, record }) => `${recordKind}-${record._id}`).join(',')}>{saved.items.length ? saved.items.map(({ kind: recordKind, record }) => card(record, recordKind)) : <EmptyState icon="bookmark" title="Make room for your next idea." action={<button className="button button-primary" onClick={() => selectSection('explore')}>Explore research<Icon name="arrow" size={16}/></button>}><p>Save a researcher or publication while you browse. You’ll find it here when you come back.</p></EmptyState>}</MotionList></>}
        <footer className="content-footer"><span><Icon name="book" size={15}/>Explore with curiosity. Follow the evidence.</span><span>{demo ? 'Illustrative data' : 'Counts reflect this collection'}</span></footer>
      </main>
      {selected.length > 0 && <div className="compare-tray" aria-live="polite"><div><div className="compare-avatars" aria-hidden="true">{selected.map(record => <span className="compare-avatar" key={record._id} data-compare-avatar={record._id}>{initialsFor(record.name)}</span>)}</div><div><strong>{selected.length} of 3 researchers selected</strong><span className="compare-names">{selected.map((record) => record.name).join(' · ')}</span></div></div><div><button className="button button-quiet" onClick={() => setComparison({ demo, records: [] })}>Clear</button><button className="button button-primary" disabled={selected.length < 2} onClick={() => { setDetail(null); setShowCompare(true); }}>Compare selected<Icon name="arrow" size={16}/></button></div></div>}
    </div>
    {detail && <RecordDialog key={`${demo}-${detail.kind}-${detail.id}`} {...detail} demo={demo} saved={saved} onOpen={openRecord} onClose={() => setDetail(null)} onCompare={toggleCompare} selected={selected.some((record) => record._id === detail.id)} compareFull={selected.length === 3}/>}
    {showCompare && <CompareDialog records={selected} saved={saved} onClose={() => setShowCompare(false)} onOpen={openRecord}/>}
  </div>;
}
