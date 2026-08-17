import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api, setApiToken, streamEvents, type CollectionJob, type ExportRecord, type Source } from "./api.js";

type Page = "dashboard" | "jobs" | "failures" | "exports" | "library" | "settings";

const nav: Array<{ id: Page; label: string; icon: ReactNode }> = [
  { id: "dashboard", label: "Overview", icon: <Icon path="M4 13h6V4H4v9Zm0 7h6v-5H4v5Zm10 0h6v-9h-6v9Zm0-16v5h6V4h-6Z" /> },
  { id: "jobs", label: "Collection jobs", icon: <Icon path="M12 3v12m0 0 4-4m-4 4-4-4M5 19h14" /> },
  { id: "failures", label: "Failure review", icon: <Icon path="M12 9v4m0 4h.01M10.3 3.9 2.5 17.4A1 1 0 0 0 3.37 19h17.26a1 1 0 0 0 .87-1.5L13.7 3.9a1 1 0 0 0-1.4 0Z" /> },
  { id: "exports", label: "Transfer packages", icon: <Icon path="M5 3h10l4 4v14H5V3Zm9 0v5h5M9 13h6m-6 4h6" /> },
  { id: "library", label: "Archive library", icon: <Icon path="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5v-15Zm0 15A2.5 2.5 0 0 1 6.5 18H20v3H6.5A2.5 2.5 0 0 1 4 18.5" /> },
  { id: "settings", label: "Source settings", icon: <Icon path="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5ZM19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.12 2.12-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.04 1.55V20.3h-3v-.09a1.7 1.7 0 0 0-1.04-1.55 1.7 1.7 0 0 0-1.88.34l-.06.06-2.12-2.12.06-.06A1.7 1.7 0 0 0 7 15a1.7 1.7 0 0 0-1.55-1.04H5.3v-3h.15A1.7 1.7 0 0 0 7 9.92a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.12-2.12.06.06A1.7 1.7 0 0 0 10.66 6a1.7 1.7 0 0 0 1.04-1.55V4.3h3v.15A1.7 1.7 0 0 0 15.74 6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.12 2.12-.06.06a1.7 1.7 0 0 0-.34 1.88 1.7 1.7 0 0 0 1.55 1.04h.15v3h-.15A1.7 1.7 0 0 0 19.4 15Z" /> },
];

export default function App() {
  const [page, setPage] = useState<Page>("dashboard");
  const [tokenVersion, setTokenVersion] = useState(0);
  const health = useQuery({ queryKey: ["health", tokenVersion], queryFn: api.health, refetchInterval: 15_000, retry: 1 });
  const sources = useQuery({ queryKey: ["sources"], queryFn: api.sources, refetchInterval: 10_000 });
  const source = sources.data?.sources.find((candidate) => candidate.key === "ao3") ?? sources.data?.sources[0];
  if (health.error instanceof ApiError && health.error.status === 401) {
    return <Unlock onUnlock={(token) => { setApiToken(token); setTokenVersion((value) => value + 1); void health.refetch(); }} />;
  }

  return <div className="app-shell">
    <LiveEvents enabled={health.isSuccess} />
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">AR</div><div><strong>Archive Relay</strong><span>Offline preservation</span></div></div>
      <nav aria-label="Primary navigation">
        {nav.map((item) => <button key={item.id} className={page === item.id ? "nav-item active" : "nav-item"} onClick={() => setPage(item.id)}>
          {item.icon}<span>{item.label}</span>
        </button>)}
      </nav>
      <div className="sidebar-foot">
        <div className="status-row"><span className={health.isSuccess ? "status-dot good" : "status-dot bad"} /><span>{health.isSuccess ? "API connected" : "API unavailable"}</span></div>
        <div className="version">Collector 0.1 · Private</div>
      </div>
    </aside>
    <main>
      <header className="topbar">
        <div><p className="eyebrow">PRIVATE OFFLINE ARCHIVE</p><h1>{nav.find((item) => item.id === page)?.label}</h1></div>
        <div className="source-chip"><span className={source?.paused ? "status-dot warn" : "status-dot good"} /><div><b>{source?.key ?? "No source"}</b><small>{source ? source.paused ? "Paused" : "Collection enabled" : "Configure a source"}</small></div></div>
      </header>
      <div className="content">
        {page === "dashboard" && <Dashboard source={source} onNavigate={setPage} />}
        {page === "jobs" && <Jobs source={source} />}
        {page === "failures" && <Failures />}
        {page === "exports" && <Exports source={source} />}
        {page === "library" && <Library />}
        {page === "settings" && <Settings source={source} />}
      </div>
    </main>
  </div>;
}

function LiveEvents({ enabled }: { enabled: boolean }) {
  const client = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const run = async () => {
      while (!controller.signal.aborted) {
        try {
          await streamEvents((event) => {
            if (event.type === "jobs" && event.data && typeof event.data === "object" && "jobs" in event.data) {
              client.setQueryData(["jobs"], { jobs: (event.data as { jobs: CollectionJob[] }).jobs });
            }
            if (event.type === "exports" && event.data && typeof event.data === "object" && "exports" in event.data) {
              const payload = event.data as { exports: ExportRecord[]; total: number };
              client.setQueryData(["exports", 0], payload);
            }
          }, controller.signal);
        } catch {
          if (controller.signal.aborted) return;
        }
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
    };
    void run();
    return () => controller.abort();
  }, [enabled, client]);
  return null;
}

function Dashboard({ source, onNavigate }: { source: Source | undefined; onNavigate: (page: Page) => void }) {
  const jobs = useQuery({ queryKey: ["jobs"], queryFn: api.jobs, refetchInterval: 30_000 });
  const works = useQuery({ queryKey: ["works"], queryFn: () => api.works(), refetchInterval: 10_000 });
  const list = jobs.data?.jobs ?? [];
  const workList = works.data?.works ?? [];
  const active = list.filter((job) => ["queued", "running"].includes(job.status));
  const totalWords = workList.reduce((sum, work) => sum + (work.words ?? 0), 0);
  const failed = list.reduce((sum, job) => sum + job.failedCount, 0);
  return <>
    <section className="hero-panel">
      <div><p className="eyebrow accent">SYSTEM SUMMARY</p><h2>Your private archive, quietly building.</h2><p>Collect conservatively, retain original captures, and move verified works into your offline OTW Archive.</p></div>
      <button className="primary" onClick={() => onNavigate("jobs")}><Icon path="M12 5v14M5 12h14" />New collection job</button>
    </section>
    {!source && <Notice title="Configure your first source" text="Create the AO3 source in Settings. New sources begin paused so nothing is requested accidentally." action={() => onNavigate("settings")} />}
    <section className="metric-grid">
      <Metric label="Collected works" value={formatNumber(workList.length)} note="Loaded in current view" tone="violet" />
      <Metric label="Archived words" value={compactNumber(totalWords)} note="Across loaded works" tone="cyan" />
      <Metric label="Active jobs" value={formatNumber(active.length)} note={source?.paused ? "Source is paused" : "Worker may claim tasks"} tone="amber" />
      <Metric label="Terminal failures" value={formatNumber(failed)} note="Available for review" tone={failed ? "rose" : "green"} />
    </section>
    <section className="two-column">
      <Panel title="Recent collection jobs" action={<button className="text-button" onClick={() => onNavigate("jobs")}>View all →</button>}>
        {list.length ? <div className="job-stack">{list.slice(0, 5).map((job) => <JobRow job={job} key={job.id} />)}</div> : <Empty title="No collection jobs yet" text="Create a small ID range when you are ready." />}
      </Panel>
      <Panel title="Safety controls">
        <div className="safety-list">
          <Safety label="Source requests" value={source?.paused ? "Paused" : "Enabled"} good={!source?.paused} />
          <Safety label="Minimum delay" value={source ? `${source.minimumDelayMs / 1000}s` : "—"} good />
          <Safety label="Daily request cap" value={source?.dailyRequestBudget?.toString() ?? "Unlimited"} good={source?.dailyRequestBudget !== null} />
          <Safety label="Visibility" value="Private / restricted" good />
        </div>
      </Panel>
    </section>
  </>;
}

function Jobs({ source }: { source: Source | undefined }) {
  const client = useQueryClient();
  const jobs = useQuery({ queryKey: ["jobs"], queryFn: api.jobs, refetchInterval: 30_000 });
  const [showForm, setShowForm] = useState(false);
  const control = useMutation({ mutationFn: ({ id, action }: { id: number; action: "pause" | "resume" | "cancel" }) => api.controlJob(id, action), onSuccess: () => client.invalidateQueries({ queryKey: ["jobs"] }) });
  return <>
    <div className="page-actions"><div><h2>Durable collection queue</h2><p>Jobs survive worker and API restarts. Source limits apply across every worker.</p></div><button className="primary" disabled={!source} onClick={() => setShowForm(true)}><Icon path="M12 5v14M5 12h14" />New job</button></div>
    {showForm && source && <JobForm source={source} onClose={() => setShowForm(false)} />}
    <Panel title="All jobs">
      {jobs.data?.jobs.length ? <div className="table-wrap"><table><thead><tr><th>Job</th><th>Range</th><th>Status</th><th>Progress</th><th>Created</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>
        {jobs.data.jobs.map((job) => <tr key={job.id}><td><b>#{job.id}</b><small>{job.type.replace("_", " ")}</small></td><td>{job.configuration.start ?? "—"}–{job.configuration.end ?? "—"}</td><td><Status status={displayJobStatus(job)} /></td><td><Progress job={job} /></td><td>{formatDate(job.createdAt)}</td><td><div className="row-actions">
          {job.status === "running" && <button onClick={() => control.mutate({ id: job.id, action: "pause" })}>Pause</button>}
          {job.status === "paused" && <button onClick={() => control.mutate({ id: job.id, action: "resume" })}>Resume</button>}
          {!['completed','cancelled'].includes(job.status) && <button className="danger" onClick={() => control.mutate({ id: job.id, action: "cancel" })}>Cancel</button>}
        </div></td></tr>)}
      </tbody></table></div> : <Empty title="The queue is empty" text="Create a small job to begin collecting." />}
    </Panel>
  </>;
}

function JobForm({ source, onClose }: { source: Source; onClose: () => void }) {
  const client = useQueryClient();
  const [start, setStart] = useState(1);
  const [end, setEnd] = useState(10);
  const mutation = useMutation({
    mutationFn: () => api.createJob({ sourceId: source.id, start, end, batchSize: 250 }),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ["jobs"] }); onClose(); },
  });
  const count = Math.max(0, end - start + 1);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><form className="modal" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}>
    <div className="modal-head"><div><p className="eyebrow accent">NEW COLLECTION</p><h2>ID range job</h2></div><button type="button" className="icon-button" aria-label="Close" onClick={onClose}>×</button></div>
    <p className="muted">Tasks are created durably. The source is currently <b>{source.paused ? "paused" : "enabled"}</b>, with a {source.minimumDelayMs / 1000}-second minimum delay.</p>
    <div className="form-grid"><label>Starting work ID<input type="number" min="1" value={start} onChange={(e) => setStart(Number(e.target.value))} /></label><label>Ending work ID<input type="number" min={start} value={end} onChange={(e) => setEnd(Number(e.target.value))} /></label></div>
    <div className="estimate"><span>{formatNumber(count)} tasks</span><span>≈ {duration(count * source.minimumDelayMs)}</span></div>
    {mutation.error && <p className="form-error">{mutation.error.message}</p>}
    <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={mutation.isPending || count < 1 || count > 10_000_000}>{mutation.isPending ? "Creating…" : "Create durable job"}</button></div>
  </form></div>;
}

function Exports({ source }: { source: Source | undefined }) {
  const client = useQueryClient();
  const pageSize = 25;
  const [page, setPage] = useState(0);
  const [maximumWorks, setMaximumWorks] = useState(500);
  const exportsQuery = useQuery({ queryKey: ["exports", page], queryFn: () => api.exports(page, pageSize), refetchInterval: 30_000 });
  const create = useMutation({
    mutationFn: () => source ? api.createExport({ sourceId: source.id, maximumWorks }) : Promise.reject(new Error("No source configured")),
    onSuccess: () => client.invalidateQueries({ queryKey: ["exports"] }),
  });
  const rows = exportsQuery.data?.exports ?? [];
  const total = exportsQuery.data?.total ?? 0;
  return <>
    <div className="page-actions"><div><h2>Transfer packages</h2><p>Durable snapshot and incremental exports ready for the OTW importer.</p></div><div className="export-create"><label>Maximum works<input type="number" min="1" max="5000" value={maximumWorks} onChange={(event) => setMaximumWorks(Number(event.target.value))} /></label><button className="primary" disabled={!source || create.isPending} onClick={() => create.mutate()}>{create.isPending ? "Queueing…" : "Queue export"}</button></div></div>
    <Panel title={`${formatNumber(total)} export requests`}>
      {rows.length ? <><div className="table-wrap"><table><thead><tr><th>Package</th><th>Type / parent</th><th>Status</th><th>Works</th><th>Output</th><th>Completed</th></tr></thead><tbody>{rows.map((record) => <tr key={record.id}><td><b>{record.packageId.slice(0, 8)}…</b><small>Export #{record.id}</small></td><td>{record.previousPackageId ? <><b>Incremental</b><small>After {record.previousPackageId.slice(0, 8)}…</small></> : <><b>Snapshot</b><small>First package</small></>}</td><td><Status status={record.status} />{record.errorMessage && <small className="export-error">{record.errorMessage}</small>}</td><td>{formatNumber(record.workCount)} / {formatNumber(record.maximumWorks)}</td><td className="path-cell" title={record.outputDirectory}>{record.outputDirectory}</td><td>{record.completedAt ? formatDateTime(record.completedAt) : "—"}</td></tr>)}</tbody></table></div><div className="pagination"><button disabled={page === 0} onClick={() => setPage((value) => value - 1)}>← Previous</button><span>Page {page + 1}</span><button disabled={(page + 1) * pageSize >= total} onClick={() => setPage((value) => value + 1)}>Next →</button></div></> : <Empty title="No transfer packages yet" text="Queue an export after works have been collected. The export worker writes and verifies it asynchronously." />}
      {create.error && <p className="form-error">{create.error.message}</p>}
    </Panel>
  </>;
}

function Failures() {
  const client = useQueryClient();
  const pageSize = 25;
  const [page, setPage] = useState(0);
  const failures = useQuery({ queryKey: ["failures", page], queryFn: () => api.failures(page, pageSize), refetchInterval: 5000 });
  const retry = useMutation({ mutationFn: api.retryFailures, onSuccess: () => Promise.all([
    client.invalidateQueries({ queryKey: ["failures"] }), client.invalidateQueries({ queryKey: ["jobs"] }),
  ]) });
  const rows = failures.data?.failures ?? [];
  const total = failures.data?.total ?? 0;
  return <>
    <div className="page-actions"><div><h2>Failure review</h2><p>Inspect retryable and terminal outcomes without losing captured content.</p></div></div>
    <Panel title={`${formatNumber(total)} failures requiring attention`}>
      {rows.length ? <><div className="table-wrap"><table><thead><tr><th>Work</th><th>Job</th><th>State</th><th>Attempts</th><th>Error</th><th>Updated</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{rows.map((failure) => <tr key={failure.taskId}><td><b>AO3 #{failure.sourceWorkId}</b><small>Task #{failure.taskId}</small></td><td>#{failure.jobId}</td><td><Status status={failure.status} /></td><td>{failure.attempts}</td><td className="error-cell"><b>{failure.errorCode ?? "Unknown error"}</b><small>{failure.errorMessage ?? "No error detail was recorded."}</small></td><td>{formatDateTime(failure.updatedAt)}</td><td><button className="read-button" disabled={retry.isPending} onClick={() => retry.mutate(failure.jobId)}>Retry job failures</button></td></tr>)}</tbody></table></div><div className="pagination"><button disabled={page === 0} onClick={() => setPage((value) => value - 1)}>← Previous</button><span>Page {page + 1}</span><button disabled={(page + 1) * pageSize >= total} onClick={() => setPage((value) => value + 1)}>Next →</button></div></> : <Empty title="No failures to review" text="Retryable and terminal task errors will appear here." />}
    </Panel>
  </>;
}

function Library() {
  const pageSize = 10;
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState("");
  const [selectedWork, setSelectedWork] = useState<number | null>(null);
  const works = useQuery({
    queryKey: ["works", page, filter],
    queryFn: () => api.works(page, pageSize, filter),
    placeholderData: (previous) => previous,
  });
  const list = works.data?.works ?? [];
  const total = works.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return <>
    <div className="page-actions"><div><h2>Collected works</h2><p>Normalized records backed by immutable raw captures.</p></div><div className="search"><Icon path="m21 21-4.35-4.35M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z" /><input aria-label="Search works" placeholder="Search title or source ID" value={filter} onChange={(e) => { setFilter(e.target.value); setPage(0); }} /></div></div>
    <Panel title={`${formatNumber(total)} collected works`}>
      {list.length ? <>
        <div className="table-wrap work-list"><table><thead><tr><th>Work title</th><th>Source ID</th><th>Words</th><th>Chapters</th><th>Status</th><th>Updated</th><th><span className="sr-only">Open</span></th></tr></thead><tbody>
          {list.map((work) => <tr key={work.id}><td className="title-cell"><b>{work.title || "Untitled work"}</b><small>{work.complete ? "Complete" : "In progress"} · {work.languageCode.toUpperCase()}</small></td><td><span className="source-id">AO3 #{work.sourceWorkId}</span></td><td>{formatNumber(work.words ?? 0)}</td><td>{work.expectedChapters ?? "?"}</td><td><Status status={work.availability} /></td><td>{work.sourceUpdatedAt ? formatDate(work.sourceUpdatedAt) : "—"}</td><td><button className="read-button" onClick={() => setSelectedWork(work.id)}>View</button></td></tr>)}
        </tbody></table></div>
        <div className="pagination"><button disabled={page === 0} onClick={() => setPage((value) => value - 1)}>← Previous</button><span>Page <b>{page + 1}</b> of {pages}</span><button disabled={page + 1 >= pages} onClick={() => setPage((value) => value + 1)}>Next →</button></div>
      </> : <Empty title="No matching works" text="Collected works will appear here after a worker succeeds." />}
    </Panel>
    {selectedWork !== null && <WorkReader workId={selectedWork} onClose={() => setSelectedWork(null)} />}
  </>;
}

function WorkReader({ workId, onClose }: { workId: number; onClose: () => void }) {
  const work = useQuery({ queryKey: ["work", workId], queryFn: () => api.work(workId) });
  const [chapterId, setChapterId] = useState<number | null>(null);
  useEffect(() => {
    const first = work.data?.work.chapters[0]?.id;
    if (first) setChapterId(first);
  }, [work.data?.work.id]);
  const chapter = useQuery({
    queryKey: ["chapter", workId, chapterId],
    queryFn: () => api.chapter(workId, chapterId!),
    enabled: chapterId !== null,
  });
  const detail = work.data?.work;
  return <div className="reader-backdrop"><section className="reader" role="dialog" aria-modal="true" aria-label={detail?.title ?? "Work reader"}>
    <header><div><p className="eyebrow accent">OFFLINE ARCHIVE READER</p><h2>{detail?.title ?? "Loading work…"}</h2>{detail && <p>AO3 #{detail.sourceWorkId} · {formatNumber(detail.words ?? 0)} words · {detail.chapters.length} chapters</p>}</div><button className="icon-button" aria-label="Close reader" onClick={onClose}>×</button></header>
    {detail && <div className="reader-layout"><aside><div className="reader-summary"><b>Summary</b><p>{htmlToText(detail.summaryHtml) || "No summary."}</p></div><b className="chapter-label">Chapters</b><div className="chapter-nav">{detail.chapters.map((item) => <button className={chapterId === item.id ? "active" : ""} key={item.id} onClick={() => setChapterId(item.id)}><span>{item.position}</span><div>{item.title || `Chapter ${item.position}`}<small>{item.wordCount ? `${formatNumber(item.wordCount)} words` : "Word count unavailable"}</small></div></button>)}</div></aside><article className="chapter-reader">{chapter.isLoading ? <p className="muted">Loading chapter…</p> : chapter.data ? <><p className="eyebrow">CHAPTER {chapter.data.chapter.position}</p><h3>{chapter.data.chapter.title || detail.title}</h3>{htmlToText(chapter.data.chapter.notesHtml) && <div className="reader-note">{htmlToText(chapter.data.chapter.notesHtml)}</div>}<div className="chapter-text">{htmlToParagraphs(chapter.data.chapter.contentHtml)}</div>{htmlToText(chapter.data.chapter.endNotesHtml) && <div className="reader-note end"><b>End notes</b>{htmlToText(chapter.data.chapter.endNotesHtml)}</div>}</> : <p>Choose a chapter.</p>}</article></div>}
  </section></div>;
}

function Settings({ source }: { source: Source | undefined }) {
  const client = useQueryClient();
  const [userAgent, setUserAgent] = useState(source?.userAgent ?? "");
  const [includeAdult, setIncludeAdult] = useState(source?.includeAdult ?? true);
  const [delay, setDelay] = useState(source?.minimumDelayMs ?? 10000);
  const [budget, setBudget] = useState(source?.dailyRequestBudget ?? 250);
  const [byteBudgetMb, setByteBudgetMb] = useState(Math.round((source?.dailyByteBudget ?? 1_073_741_824) / 1_048_576));
  const [timeoutSeconds, setTimeoutSeconds] = useState((source?.requestTimeoutMs ?? 60_000) / 1000);
  const [maxResponseMb, setMaxResponseMb] = useState(Math.round((source?.maximumResponseBytes ?? 20_971_520) / 1_048_576));
  const [attempts, setAttempts] = useState(source?.maximumFailureAttempts ?? 6);
  const [windowEnabled, setWindowEnabled] = useState(source?.operatingWindowStartHourUtc !== null);
  const [windowStart, setWindowStart] = useState(source?.operatingWindowStartHourUtc ?? 0);
  const [windowEnd, setWindowEnd] = useState(source?.operatingWindowEndHourUtc ?? 6);
  useEffect(() => {
    if (!source) return;
    setUserAgent(source.userAgent); setIncludeAdult(source.includeAdult); setDelay(source.minimumDelayMs);
    setBudget(source.dailyRequestBudget ?? 250); setByteBudgetMb(Math.round((source.dailyByteBudget ?? 1_073_741_824) / 1_048_576));
    setTimeoutSeconds(source.requestTimeoutMs / 1000); setMaxResponseMb(Math.round(source.maximumResponseBytes / 1_048_576));
    setAttempts(source.maximumFailureAttempts); setWindowEnabled(source.operatingWindowStartHourUtc !== null);
    setWindowStart(source.operatingWindowStartHourUtc ?? 0); setWindowEnd(source.operatingWindowEndHourUtc ?? 6);
  }, [source]);
  const update = useMutation({ mutationFn: (paused: boolean) => source ? api.updateSource(source.id, {
    userAgent, includeAdult, minimumDelayMs: delay, dailyRequestBudget: budget,
    dailyByteBudget: byteBudgetMb * 1_048_576, requestTimeoutMs: timeoutSeconds * 1000,
    maximumResponseBytes: maxResponseMb * 1_048_576, maximumFailureAttempts: attempts,
    operatingWindowStartHourUtc: windowEnabled ? windowStart : null,
    operatingWindowEndHourUtc: windowEnabled ? windowEnd : null, paused,
  }) : Promise.reject(new Error("No source")), onSuccess: () => client.invalidateQueries({ queryKey: ["sources"] }) });
  const create = useMutation({ mutationFn: () => api.createSource({ key: "ao3", origin: "https://archiveofourown.org" }), onSuccess: () => client.invalidateQueries({ queryKey: ["sources"] }) });
  if (!source) return <Panel title="Create source"><div className="settings-empty"><div className="large-icon"><Icon path="M12 3v18m9-9H3" /></div><h2>No collection source configured</h2><p>AO3 will be created paused with a standard Chrome browser identity, 10-second delay, and 250-request daily budget.</p><button className="primary" onClick={() => create.mutate()}>{create.isPending ? "Creating…" : "Create paused AO3 source"}</button></div></Panel>;
  return <div className="settings-layout">
    <Panel title="Source policy"><div className="settings-form">
      <div className="settings-section"><h3>Browser identity</h3><label>Browser ID / User-Agent<textarea rows={3} value={userAgent} onChange={(e) => setUserAgent(e.target.value)} /><small>Defaults to a standard Chrome browser identity. You can append a project contact identifier if desired.</small></label><label className="toggle-row"><input type="checkbox" checked={includeAdult} onChange={(e) => setIncludeAdult(e.target.checked)} /><span><b>Accept adult-content interstitials</b><small>Allows collection of all publicly accessible ratings.</small></span></label></div>
      <div className="settings-section"><h3>Request pacing and budgets</h3><div className="form-grid"><label>Minimum delay (ms)<input type="number" min="2000" value={delay} onChange={(e) => setDelay(Number(e.target.value))} /></label><label>Daily requests<input type="number" min="1" value={budget} onChange={(e) => setBudget(Number(e.target.value))} /></label><label>Daily bandwidth (MB)<input type="number" min="1" value={byteBudgetMb} onChange={(e) => setByteBudgetMb(Number(e.target.value))} /></label><label>Maximum response (MB)<input type="number" min="1" max="100" value={maxResponseMb} onChange={(e) => setMaxResponseMb(Number(e.target.value))} /></label></div></div>
      <div className="settings-section"><h3>Failures and schedule</h3><div className="form-grid"><label>Request timeout (seconds)<input type="number" min="5" max="300" value={timeoutSeconds} onChange={(e) => setTimeoutSeconds(Number(e.target.value))} /></label><label>Maximum failure attempts<input type="number" min="1" max="20" value={attempts} onChange={(e) => setAttempts(Number(e.target.value))} /></label></div><label className="toggle-row"><input type="checkbox" checked={windowEnabled} onChange={(e) => setWindowEnabled(e.target.checked)} /><span><b>Restrict collection to a UTC window</b><small>Useful for operating only during agreed low-traffic hours.</small></span></label>{windowEnabled && <div className="form-grid"><label>Start hour UTC<input type="number" min="0" max="23" value={windowStart} onChange={(e) => setWindowStart(Number(e.target.value))} /></label><label>End hour UTC<input type="number" min="0" max="23" value={windowEnd} onChange={(e) => setWindowEnd(Number(e.target.value))} /></label></div>}</div>
      <div className="policy-callout"><Icon path="M12 9v4m0 4h.01M10.3 3.9 2.5 17.4A1 1 0 0 0 3.37 19h17.26a1 1 0 0 0 .87-1.5L13.7 3.9a1 1 0 0 0-1.4 0Z" /><p><b>Distributed safety boundary</b><span>Delay, request, bandwidth, and schedule controls are enforced transactionally across every worker.</span></p></div><div className="settings-actions"><button className="secondary" onClick={() => update.mutate(true)}>Save & pause</button><button className={source.paused ? "primary" : "danger-button"} onClick={() => update.mutate(!source.paused)}>{source.paused ? "Enable collection" : "Pause immediately"}</button></div>{update.error && <p className="form-error">{update.error.message}</p>}
    </div></Panel>
    <Panel title="Current state"><div className="source-detail"><span className={source.paused ? "orb paused" : "orb"} /><h3>{source.paused ? "Collection paused" : "Collection enabled"}</h3><p>{source.paused ? "Workers cannot claim new tasks from this source." : "Workers may claim tasks within the configured limits."}</p><dl><div><dt>Source</dt><dd>{source.origin}</dd></div><div><dt>Next request slot</dt><dd>{source.nextRequestAt ? formatDateTime(source.nextRequestAt) : "Available"}</dd></div><div><dt>Adult content</dt><dd>{source.includeAdult ? "Allowed" : "Excluded"}</dd></div><div><dt>Daily bandwidth</dt><dd>{compactNumber(source.dailyByteBudget ?? 0)}B</dd></div><div><dt>Operating window</dt><dd>{source.operatingWindowStartHourUtc === null ? "Any time" : `${source.operatingWindowStartHourUtc}:00–${source.operatingWindowEndHourUtc}:00 UTC`}</dd></div><div><dt>Archive visibility</dt><dd>Private</dd></div></dl></div></Panel>
  </div>;
}

function Unlock({ onUnlock }: { onUnlock: (token: string) => void }) {
  const [token, setToken] = useState("");
  return <main className="unlock-screen"><form onSubmit={(event) => { event.preventDefault(); onUnlock(token.trim()); }}><div className="brand-mark">AR</div><p className="eyebrow accent">ARCHIVE RELAY</p><h1>Unlock operator access</h1><p>Enter the API token configured on this private collector.</p><label>API token<input autoFocus type="password" minLength={32} value={token} onChange={(event) => setToken(event.target.value)} /></label><button className="primary" disabled={token.trim().length < 32}>Unlock archive</button><small>The token remains in this browser's local storage.</small></form></main>;
}

function Panel({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) { return <section className="panel"><div className="panel-head"><h2>{title}</h2>{action}</div>{children}</section>; }
function Metric({ label, value, note, tone }: { label: string; value: string; note: string; tone: string }) { return <article className={`metric ${tone}`}><span>{label}</span><strong>{value}</strong><small>{note}</small></article>; }
function Empty({ title, text }: { title: string; text: string }) { return <div className="empty"><div className="empty-mark">· · ·</div><h3>{title}</h3><p>{text}</p></div>; }
function Notice({ title, text, action }: { title: string; text: string; action: () => void }) { return <div className="notice"><Icon path="M12 9v4m0 4h.01M10.3 3.9 2.5 17.4A1 1 0 0 0 3.37 19h17.26a1 1 0 0 0 .87-1.5L13.7 3.9a1 1 0 0 0-1.4 0Z" /><div><b>{title}</b><span>{text}</span></div><button onClick={action}>Open settings</button></div>; }
function Safety({ label, value, good }: { label: string; value: string; good: boolean }) { return <div><span><i className={good ? "check" : "pause-icon"}>{good ? "✓" : "Ⅱ"}</i>{label}</span><b>{value}</b></div>; }
function Status({ status }: { status: string }) { return <span className={`status ${status}`}>{status.replace("_", " ")}</span>; }
function Progress({ job }: { job: CollectionJob }) { const done = job.succeededCount + job.failedCount + job.skippedCount; const percent = job.discoveredCount ? Math.round(done / job.discoveredCount * 100) : 0; return <div className="progress-cell"><div><span style={{ width: `${percent}%` }} /></div><small>{job.planningStatus !== "completed" ? `Planning · ${formatNumber(job.discoveredCount)} queued` : `${done}/${job.discoveredCount} · ${percent}%`}</small></div>; }
function displayJobStatus(job: CollectionJob): string {
  if (job.planningStatus === "failed") return "planning_failed";
  if (job.planningStatus !== "completed") return "planning";
  return job.status;
}
function JobRow({ job }: { job: CollectionJob }) { return <div className="job-row"><div className="job-icon"><Icon path="M12 4v12m0 0 4-4m-4 4-4-4" /></div><div><b>Job #{job.id}</b><span>{job.configuration.start ?? "?"}–{job.configuration.end ?? "?"} · {formatNumber(job.discoveredCount)} tasks</span></div><Status status={displayJobStatus(job)} /><time>{formatDate(job.createdAt)}</time></div>; }
function Icon({ path }: { path: string }) { return <svg aria-hidden="true" viewBox="0 0 24 24"><path d={path} /></svg>; }

const formatNumber = (value: number) => new Intl.NumberFormat().format(value);
const compactNumber = (value: number) => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
const formatDate = (value: string) => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(value));
const formatDateTime = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
function duration(ms: number) { const minutes = Math.ceil(ms / 60000); return minutes < 60 ? `${minutes} min minimum` : `${Math.floor(minutes / 60)}h ${minutes % 60}m minimum`; }
function htmlToText(html: string) {
  if (!html) return "";
  return new DOMParser().parseFromString(html, "text/html").body.textContent?.replace(/\s+/g, " ").trim() ?? "";
}
function htmlToParagraphs(html: string) {
  const document = new DOMParser().parseFromString(html, "text/html");
  const blocks = [...document.body.querySelectorAll("p, li, blockquote, h1, h2, h3, h4")]
    .map((node) => node.textContent?.replace(/\s+/g, " ").trim()).filter(Boolean) as string[];
  const paragraphs = blocks.length ? blocks : [document.body.textContent?.trim() ?? ""];
  return paragraphs.filter(Boolean).map((text, index) => <p key={`${index}-${text.slice(0, 20)}`}>{text}</p>);
}
