import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Box,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleAlert,
  Clipboard,
  Code2,
  Command,
  Database,
  Ellipsis,
  FileText,
  Folder,
  GitBranch,
  Layers,
  Loader2,
  Menu,
  Network,
  Pause,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Terminal,
  Unplug,
  Upload,
  Waypoints,
  X,
} from 'lucide-react';
import type {
  ApplicationRecord,
  CommandInput,
  CommandRecord,
  EventAction,
  EventContext,
  Incident,
  ProjectRecord,
  QueryResult,
  RetentionPolicy,
  Severity,
  StoredEvent,
  StreamMessage,
} from '@rippley/blackbox-protocol';
import { DEFAULT_RETENTION } from '@rippley/blackbox-protocol';
import { api, patch, post } from './api';

type Page = 'timeline' | 'projects' | 'applications' | 'incidents' | 'integrations' | 'settings';
type Health = {
  status: string;
  version: string;
  uptime: number;
  eventCount: number;
  latestSequence: number;
  remoteSync: false;
};
type ProjectView = {
  project: ProjectRecord;
  events: StoredEvent[];
  stats: {
    status: string;
    runningProcesses: number | unknown[];
    ports: number[];
    lastCommand?: string | StoredEvent | null;
    lastDeployment?: string | StoredEvent | null;
    environmentWarnings: number;
    errorsToday: number;
    connectedTools: string[];
  };
};
type Toast = { text: string; error?: boolean };
const severities: Severity[] = ['debug', 'info', 'success', 'warning', 'error', 'critical'];
const projectName = (event: StoredEvent) =>
  event.project?.name ||
  event.project?.id ||
  event.project?.repo?.split('/').pop() ||
  event.project?.path?.split('/').pop() ||
  'Unassigned';
const appName = (app: string) => app.replace(/[-_]/g, ' ');
const time = (value: string) =>
  new Date(value).toLocaleTimeString([], {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
const shortDate = (value: string) =>
  new Date(value).toLocaleDateString([], { month: 'short', day: 'numeric' });
function ago(value: string) {
  const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
  return seconds < 60
    ? 'just now'
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m ago`
      : seconds < 86400
        ? `${Math.floor(seconds / 3600)}h ago`
        : `${Math.floor(seconds / 86400)}d ago`;
}
const packageCommand =
  'npm run build:packages\nnpm pack -w @rippley/blackbox-protocol\nnpm pack -w @rippley/blackbox-sdk';
const installCommand =
  'npm install /path/to/black-box/rippley-blackbox-protocol-0.1.0.tgz /path/to/black-box/rippley-blackbox-sdk-0.1.0.tgz';
const integrationCode = `import { createBlackBoxClient } from '@rippley/blackbox-sdk';\n\nconst blackbox = createBlackBoxClient({\n  app: 'your-app',\n  version: '1.0.0',\n});\n\nawait blackbox.emit('application.started', {\n  message: 'Ready to record.',\n});`;

function useDialogFocus(
  ref: React.RefObject<HTMLElement | null>,
  enabled: boolean,
  onClose: () => void,
) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!enabled || !ref.current) return;
    const dialog = ref.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.getClientRects().length > 0);
    if (!dialog.contains(document.activeElement))
      (dialog.querySelector<HTMLElement>('[data-autofocus]') || focusable()[0] || dialog).focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const elements = focusable();
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (!first) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      if (
        event.shiftKey &&
        (document.activeElement === first || !dialog.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !dialog.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (previous?.isConnected) previous.focus();
    };
  }, [enabled, ref]);
}

function Logo({ small = false }: { small?: boolean }) {
  return (
    <span className={`brand-mark ${small ? 'small' : ''}`} aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}
function Badge({ children, tone = '' }: { children: ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
function Empty({
  icon,
  title,
  text,
  children,
}: {
  icon: ReactNode;
  title: string;
  text: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{text}</p>
      {children}
    </div>
  );
}
function Modal({
  title,
  eyebrow,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  eyebrow?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus(dialogRef, true, onClose);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`modal ${wide ? 'wide' : ''}`}
      >
        <header>
          <div>
            {eyebrow && <span className="eyebrow">{eyebrow}</span>}
            <h2>{title}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close dialog">
            <X size={18} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

export default function App() {
  const [page, setPage] = useState<Page>('timeline');
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [applications, setApplications] = useState<ApplicationRecord[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [connected, setConnected] = useState(false);
  const [daemonAvailable, setDaemonAvailable] = useState<boolean | null>(null);
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<number | undefined>();
  const [loading, setLoading] = useState(true);
  const [eventsError, setEventsError] = useState('');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [severityFilter, setSeverityFilter] = useState('');
  const [timeFilter, setTimeFilter] = useState('24h');
  const [paused, setPaused] = useState(false);
  const [unseen, setUnseen] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState('');
  const [projectView, setProjectView] = useState<ProjectView | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [modal, setModal] = useState<'logs' | 'palette' | 'project' | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [context, setContext] = useState<EventContext | null>(null);
  const [contextEvent, setContextEvent] = useState<StoredEvent | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState('');
  const [confirmation, setConfirmation] = useState<{ title: string; input: CommandInput } | null>(
    null,
  );
  const [activeCommand, setActiveCommand] = useState<CommandRecord | null>(null);
  const [incidentDetail, setIncidentDetail] = useState<Incident | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const contextDrawerRef = useRef<HTMLElement>(null);
  useDialogFocus(contextDrawerRef, !!contextEvent, () => setContextEvent(null));
  const latestSequence = useRef(0);
  const pausedRef = useRef(paused);
  const initialized = useRef(false);
  const alive = useRef(true);
  pausedRef.current = paused;

  const notify = useCallback((text: string, error = false) => setToast({ text, error }), []);
  const navigate = useCallback((target: Page) => {
    setPage(target);
    setMobileNav(false);
  }, []);
  const refreshRegistry = useCallback(async () => {
    const results = await Promise.allSettled([
      api<Health>('/health'),
      api<{ projects: ProjectRecord[] }>('/projects'),
      api<{ applications: ApplicationRecord[] }>('/applications'),
      api<{ incidents: Incident[] }>('/incidents'),
    ]);
    if (!alive.current) return;
    const [h, p, a, i] = results;
    if (h.status === 'fulfilled') {
      setHealth(h.value);
      setDaemonAvailable(true);
    } else setDaemonAvailable(false);
    if (p.status === 'fulfilled') setProjects(p.value.projects);
    if (a.status === 'fulfilled') setApplications(a.value.applications);
    if (i.status === 'fulfilled') setIncidents(i.value.incidents);
  }, []);
  useEffect(() => {
    alive.current = true;
    refreshRegistry();
    const interval = setInterval(refreshRegistry, 10000);
    return () => {
      alive.current = false;
      clearInterval(interval);
    };
  }, [refreshRegistry]);
  useEffect(() => {
    const id = setTimeout(() => setSearch(query), 250);
    return () => clearTimeout(id);
  }, [query]);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(id);
  }, [toast]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setContextEvent(null);
        setIncidentDetail(null);
        setConfirmation(null);
        setMobileNav(false);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setContextEvent(null);
        setIncidentDetail(null);
        setConfirmation(null);
        setModal((m) => (m === 'palette' ? null : 'palette'));
      }
      if (
        e.key === '/' &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault();
        navigate('timeline');
        requestAnimationFrame(() => searchRef.current?.focus());
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [navigate]);
  useEffect(() => {
    let disposed = false;
    let ws: WebSocket;
    let retry: ReturnType<typeof setTimeout>;
    let changeTimer: ReturnType<typeof setTimeout>;
    let retryMs = 1000;
    const connect = () => {
      if (disposed) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(
        `${protocol}//${window.location.host}/stream?since=${latestSequence.current}`,
      );
      ws.onopen = () => {
        if (!disposed) {
          setConnected(true);
          setDaemonAvailable(true);
          retryMs = 1000;
          refreshRegistry();
        }
      };
      ws.onmessage = (message) => {
        if (disposed) return;
        let data: StreamMessage;
        try {
          data = JSON.parse(message.data) as StreamMessage;
        } catch {
          return;
        }
        if (data.kind === 'ready') {
          latestSequence.current = Math.max(latestSequence.current, data.latestSequence);
          if (!pausedRef.current) setRefresh((n) => n + 1);
          initialized.current = true;
        }
        if (data.kind === 'event') {
          latestSequence.current = Math.max(latestSequence.current, data.event.sequence);
          if (pausedRef.current) {
            if (!data.replay) setUnseen((n) => n + 1);
          } else {
            clearTimeout(changeTimer);
            changeTimer = setTimeout(() => {
              setRefresh((n) => n + 1);
              refreshRegistry();
            }, 180);
          }
        }
      };
      ws.onerror = () => ws.close();
      ws.onclose = () => {
        if (!disposed) {
          setConnected(false);
          retry = setTimeout(connect, retryMs);
          retryMs = Math.min(retryMs * 1.6, 10000);
        }
      };
    };
    connect();
    return () => {
      disposed = true;
      clearTimeout(retry);
      clearTimeout(changeTimer);
      ws?.close();
    };
  }, [refreshRegistry]);
  const filters = useMemo(() => {
    const params = new URLSearchParams({ limit: '100', order: 'timestamp' });
    if (search) params.set('q', search);
    const project = page === 'projects' && selectedProject ? selectedProject : projectFilter;
    if (project) params.set('project', project);
    if (sourceFilter) params.set('source', sourceFilter);
    if (severityFilter) params.set('severity', severityFilter);
    if (timeFilter !== 'all')
      params.set(
        'from',
        new Date(
          Date.now() -
            ({ '1h': 3600000, '24h': 86400000, '7d': 604800000 }[timeFilter] || 86400000),
        ).toISOString(),
      );
    return params;
  }, [search, projectFilter, sourceFilter, severityFilter, timeFilter, page, selectedProject]);
  useEffect(() => {
    const controller = new AbortController();
    if (!initialized.current) setLoading(true);
    api<QueryResult>(`/events?${filters}`, { signal: controller.signal })
      .then((result) => {
        setEvents(result.events);
        setTotal(result.total);
        setCursor(result.nextCursor);
        setEventsError('');
        initialized.current = true;
      })
      .catch((error) => {
        if (error.name !== 'AbortError') setEventsError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [filters, refresh]);
  useEffect(() => {
    if (!selectedProject) {
      setProjectView(null);
      return;
    }
    const controller = new AbortController();
    api<ProjectView>(`/projects/${encodeURIComponent(selectedProject)}`, {
      signal: controller.signal,
    })
      .then(setProjectView)
      .catch((error) => {
        if (error.name !== 'AbortError') notify(error.message, true);
      });
    return () => controller.abort();
  }, [selectedProject, refresh, notify]);
  useEffect(() => {
    if (!activeCommand || ['completed', 'failed', 'timeout'].includes(activeCommand.status)) return;
    const interval = setInterval(() => {
      api<{ command: CommandRecord }>(`/commands/${activeCommand.id}`)
        .then(({ command }) => {
          setActiveCommand(command);
          if (command.status === 'completed') {
            notify(`${command.command} completed`);
            setRefresh((n) => n + 1);
          }
          if (command.status === 'failed' || command.status === 'timeout')
            notify(command.error || `${command.command}: ${command.status}`, true);
        })
        .catch((e) => notify(e.message, true));
    }, 1200);
    return () => clearInterval(interval);
  }, [activeCommand, notify]);

  const loadMore = async () => {
    if (!cursor) return;
    setLoading(true);
    try {
      const params = new URLSearchParams(filters);
      params.set('before', String(cursor));
      const result = await api<QueryResult>(`/events?${params}`);
      setEvents((current) => [
        ...current,
        ...result.events.filter((e) => !current.some((c) => c.id === e.id)),
      ]);
      setCursor(result.nextCursor);
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setLoading(false);
    }
  };
  const clearFilters = () => {
    setQuery('');
    setProjectFilter('');
    setSourceFilter('');
    setSeverityFilter('');
    setTimeFilter('24h');
  };
  const resume = () => {
    setPaused(false);
    setUnseen(0);
    setRefresh((n) => n + 1);
  };
  const explain = async (event: StoredEvent) => {
    setContextEvent(event);
    setContext(null);
    setContextLoading(true);
    setContextError('');
    try {
      setContext(await api<EventContext>(`/events/${event.id}/context`));
    } catch (e) {
      setContextError((e as Error).message);
    } finally {
      setContextLoading(false);
    }
  };
  const createIncident = async (event: StoredEvent) => {
    try {
      const { incident } = await post<{ incident: Incident }>('/incidents', { eventId: event.id });
      await refreshRegistry();
      notify('Incident created. Context preserved.');
      setContextEvent(null);
      setIncidentDetail(incident);
    } catch (e) {
      notify((e as Error).message, true);
    }
  };
  const routeCommand = async (input: CommandInput) => {
    try {
      const { command } = await post<{ command: CommandRecord }>('/commands', input);
      setActiveCommand(command);
      setConfirmation(null);
      notify(`Command sent to ${appName(command.provider)}`);
    } catch (e) {
      setConfirmation(null);
      notify((e as Error).message, true);
    }
  };
  const requestAction = (action: EventAction, correlationId?: string) => {
    const input = {
      provider: action.provider,
      command: action.command,
      payload: action.payload,
      correlationId,
    };
    const provider = applications.find((a) => a.id === action.provider);
    const requiresConfirmation =
      action.requiresConfirmation ||
      provider?.capabilities.find((c) => c.name === action.command)?.requiresConfirmation ||
      /(^|\.)(kill|stop|restart|delete|remove|deploy|reset|terminate)(\.|$)/i.test(action.command);
    if (requiresConfirmation) setConfirmation({ title: action.label, input });
    else routeCommand(input);
  };
  const selectProject = (id: string) => {
    setSelectedProject(id);
    clearFilters();
    navigate('projects');
  };
  const exportEvents = () => {
    window.location.assign(`/api/export?${filters}`);
  };
  const connectedApps = applications.filter((a) => a.connected).length;
  const openIncidents = incidents.filter((i) => i.status === 'open').length;
  const sourceOptions = Array.from(
    new Set([...applications.map((a) => a.id), ...events.map((e) => e.source.app)]),
  );
  const filtered = !!(
    search ||
    projectFilter ||
    sourceFilter ||
    severityFilter ||
    timeFilter !== '24h'
  );
  const pageTitles: Record<Page, string> = {
    timeline: 'Event timeline',
    projects: selectedProject ? projectView?.project.name || 'Project overview' : 'Projects',
    applications: 'Applications',
    incidents: 'Incidents',
    integrations: 'Connect your ecosystem',
    settings: 'Settings',
  };

  const timeline = (
    <>
      <div className="timeline-toolbar">
        <div className="search-box">
          <Search size={15} />
          <input
            ref={searchRef}
            aria-label="Search events"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search events, or try port:5173"
          />
          <kbd>/</kbd>
        </div>
        <button
          className={`button quiet ${paused ? 'is-paused' : ''}`}
          onClick={() => (paused ? resume() : setPaused(true))}
        >
          {paused ? <Play size={14} /> : <Pause size={14} />}
          {paused ? `Resume${unseen ? ` (${unseen})` : ''}` : 'Pause'}
        </button>
        <button
          className="icon-button"
          aria-label="Export filtered events"
          title="Export filtered events"
          onClick={exportEvents}
        >
          <ArrowDownToLine size={16} />
        </button>
      </div>
      <div className="filter-row">
        <SlidersHorizontal size={13} />
        <select
          aria-label="Filter by project"
          value={projectFilter}
          onChange={(e) => setProjectFilter(e.target.value)}
          disabled={page === 'projects' && !!selectedProject}
        >
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by source"
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
        >
          <option value="">All sources</option>
          {sourceOptions.map((source) => (
            <option key={source} value={source}>
              {appName(source)}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by severity"
          value={severityFilter}
          onChange={(e) => setSeverityFilter(e.target.value)}
        >
          <option value="">All levels</option>
          {severities.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <span className="filter-spacer" />
        <select
          aria-label="Time range"
          value={timeFilter}
          onChange={(e) => setTimeFilter(e.target.value)}
        >
          <option value="1h">Last hour</option>
          <option value="24h">Last 24 hours</option>
          <option value="7d">Last 7 days</option>
          <option value="all">All time</option>
        </select>
        {filtered && (
          <button className="text-button" onClick={clearFilters}>
            Reset
          </button>
        )}
      </div>
      <div className="timeline-columns">
        <span>
          TIME <ChevronDown size={11} />
        </span>
        <span>SOURCE / EVENT</span>
        <span>PROJECT</span>
        <span>LEVEL</span>
        <span />
      </div>
      {eventsError ? (
        <Empty
          icon={<Unplug size={25} />}
          title="The recorder is out of reach"
          text="Your data stays on this machine. Start the local daemon to reconnect and continue recording."
        >
          <code className="inline-code">npm run dev</code>
          <button
            className="button"
            onClick={() => {
              setRefresh((n) => n + 1);
              refreshRegistry();
            }}
          >
            <RefreshCw size={14} />
            Retry connection
          </button>
        </Empty>
      ) : loading && !events.length ? (
        <div className="loading-state">
          <Loader2 className="spin" size={20} />
          Reading the recorder…
        </div>
      ) : !events.length ? (
        filtered || (health?.eventCount || 0) > 0 ? (
          <Empty
            icon={<Search size={25} />}
            title="No matching signals"
            text="Try another time range or remove a filter to see more of the timeline."
          >
            <button
              className="button"
              onClick={() => {
                clearFilters();
                setTimeFilter('all');
              }}
            >
              Clear filters
            </button>
          </Empty>
        ) : (
          <div className="onboarding">
            <div className="recorder-illustration" aria-hidden="true">
              <div className="orbit orbit-one" />
              <div className="orbit orbit-two" />
              <div className="signal-line left" />
              <div className="signal-line right" />
              <div className="recorder-device">
                <Logo />
                <span>BLACK BOX</span>
                <i className={connected ? 'led' : 'led off'} />
              </div>
              <span className="sensor sensor-a">
                <Terminal size={15} />
              </span>
              <span className="sensor sensor-b">
                <GitBranch size={15} />
              </span>
              <span className="sensor sensor-c">
                <Network size={15} />
              </span>
            </div>
            <span className="eyebrow orange">AWAITING FIRST SIGNAL</span>
            <h2>
              Every app has a story.
              <br />
              Start recording yours.
            </h2>
            <p>
              Connect a tool, capture an event, and see the whole picture.
              <br />
              One timeline. Every application. All on your machine.
            </p>
            <div className="onboarding-actions">
              <button className="button primary" onClick={() => navigate('integrations')}>
                <Plus size={15} />
                Connect an application
              </button>
              <button className="button" onClick={() => setModal('logs')}>
                <Upload size={14} />
                Attach logs
              </button>
            </div>
            <div className="empty-guarantees">
              <span>
                <ShieldCheck size={13} />
                Local by default
              </span>
              <span>
                <Waypoints size={13} />
                Correlated automatically
              </span>
              <span>
                <Code2 size={13} />
                Open event protocol
              </span>
            </div>
          </div>
        )
      ) : (
        <div className="event-list">
          {events.map((event, index) => (
            <EventRow
              key={event.id}
              event={event}
              expanded={expanded === event.id}
              groupContinuation={!!event.groupId && event.groupId === events[index - 1]?.groupId}
              onExpand={() => setExpanded(expanded === event.id ? null : event.id)}
              onExplain={() => explain(event)}
              onIncident={() => createIncident(event)}
              onAction={(action) => requestAction(action, event.correlationId)}
              onProject={() => {
                const p = projects.find(
                  (p) => p.id === event.project?.id || p.name === event.project?.name,
                );
                if (p) selectProject(p.id);
              }}
              onCopy={() => {
                navigator.clipboard
                  .writeText(JSON.stringify(event, null, 2))
                  .then(() => notify('Event copied'))
                  .catch(() => notify('Clipboard is unavailable', true));
              }}
            />
          ))}
        </div>
      )}
      {cursor && events.length > 0 && !eventsError && (
        <div className="load-more">
          <button className="button" disabled={loading} onClick={loadMore}>
            {loading ? <Loader2 className="spin" size={14} /> : <ChevronDown size={14} />}Load
            earlier events
          </button>
        </div>
      )}
      <div className="timeline-bottom">
        <span>
          <span className={`status-dot ${connected && !paused ? 'green' : ''}`} />
          {paused
            ? 'Display paused · recording continues'
            : connected
              ? 'Listening for events'
              : 'Reconnecting to stream'}
        </span>
        <span>
          {events.length
            ? `${events.length.toLocaleString()} of ${total.toLocaleString()} events`
            : 'Your next signal starts here'}
        </span>
      </div>
    </>
  );

  return (
    <div className="app-shell">
      {mobileNav && <div className="nav-backdrop" onClick={() => setMobileNav(false)} />}
      <aside className={`sidebar ${mobileNav ? 'open' : ''}`}>
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            navigate('timeline');
          }}
        >
          <Logo />
          <div>
            <strong>BLACK BOX</strong>
            <span>RIPPLEY LABS</span>
          </div>
        </a>
        <div className="workspace-switch">
          <div className="workspace-avatar">
            <Terminal size={16} />
          </div>
          <div>
            <strong>Local workspace</strong>
            <span>This machine</span>
          </div>
          <Badge>LOCAL</Badge>
        </div>
        <button className="command-trigger" onClick={() => setModal('palette')}>
          <Search size={14} />
          <span>Jump to anything…</span>
          <kbd>⌘ K</kbd>
        </button>
        <div className="nav-label">OBSERVABILITY</div>
        <nav>
          {(
            [
              { id: 'timeline', label: 'Event timeline', icon: Activity },
              { id: 'projects', label: 'Projects', icon: Folder },
              { id: 'applications', label: 'Applications', icon: Layers },
              { id: 'incidents', label: 'Incidents', icon: CircleAlert },
            ] as const
          ).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`nav-item ${page === id ? 'active' : ''}`}
              onClick={() => navigate(id)}
            >
              <Icon size={16} />
              <span>{label}</span>
              {id === 'incidents' && openIncidents > 0 ? (
                <span className="nav-count warning">{openIncidents}</span>
              ) : id === 'applications' ? (
                <span className="nav-count">{applications.length}</span>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="nav-label project-label">
          <span>PROJECTS</span>
          <button
            className="icon-button"
            aria-label="Register project"
            title="Register project"
            onClick={() => setModal('project')}
          >
            <Plus size={13} />
          </button>
        </div>
        <div className="sidebar-projects">
          {projects.length ? (
            projects.slice(0, 7).map((p) => (
              <button
                className={`project-nav ${page === 'projects' && selectedProject === p.id ? 'selected' : ''}`}
                key={p.id}
                onClick={() => selectProject(p.id)}
              >
                <span className="project-glyph">
                  <Folder size={13} />
                </span>
                <span>{p.name}</span>
              </button>
            ))
          ) : (
            <div className="no-projects">
              Projects appear as your
              <br />
              applications send events.
            </div>
          )}
        </div>
        <div className="sidebar-bottom">
          <button
            className={`nav-item ${page === 'integrations' ? 'active' : ''}`}
            onClick={() => navigate('integrations')}
          >
            <Waypoints size={16} />
            <span>Integrations</span>
            <ArrowUpRight size={13} />
          </button>
          <button
            className={`nav-item ${page === 'settings' ? 'active' : ''}`}
            onClick={() => navigate('settings')}
          >
            <Settings2 size={16} />
            <span>Settings</span>
          </button>
          <div className="local-note">
            <ShieldCheck size={15} />
            <div>
              <strong>Your machine. Your data.</strong>
              <span>No cloud. No telemetry.</span>
            </div>
          </div>
          <div className="sidebar-version">
            <span>
              BLACK BOX <span className="mono">v{health?.version || '0.1.0'}</span>
            </span>
            <span className="mini-brand">R / L</span>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="icon-button mobile-menu"
              onClick={() => setMobileNav(true)}
              aria-label="Open navigation"
            >
              <Menu size={18} />
            </button>
            <span className="breadcrumb-home">Workspace</span>
            <ChevronRight size={12} />
            <strong>{pageTitles[page]}</strong>
          </div>
          <div className="topbar-right">
            <span className={`connection-pill ${connected ? 'online' : 'offline'}`}>
              <span className="status-dot" />
              {connected
                ? 'Daemon connected'
                : daemonAvailable === null
                  ? 'Connecting…'
                  : 'Stream reconnecting'}
            </span>
            <span className="local-address mono">127.0.0.1</span>
            <button
              className="icon-button"
              aria-label="Open command palette"
              onClick={() => setModal('palette')}
            >
              <Command size={16} />
            </button>
          </div>
        </header>
        <div className="page-content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                <span className="tiny-cross">+</span>
                {page === 'timeline'
                  ? 'THE ECOSYSTEM FLIGHT RECORDER'
                  : page === 'projects'
                    ? 'SHARED PROJECT INTELLIGENCE'
                    : page === 'applications'
                      ? 'YOUR CONNECTED SENSORS'
                      : page === 'incidents'
                        ? 'FROM SIGNAL TO UNDERSTANDING'
                        : page === 'integrations'
                          ? 'BUILT TO WORK TOGETHER'
                          : 'LOCAL RECORDER CONFIGURATION'}
              </div>
              <h1>
                {pageTitles[page]}
                {page === 'timeline' && (
                  <span className={`recording-tag ${connected ? '' : 'offline'}`}>
                    <span className="status-dot" />
                    {connected ? 'RECORDING' : 'OFFLINE'}
                  </span>
                )}
              </h1>
              <p>
                {page === 'timeline'
                  ? 'Everything that happens. Across everything you build.'
                  : page === 'projects'
                    ? 'One identity. Every process, deployment, and signal.'
                    : page === 'applications'
                      ? 'Independent tools. A shared nervous system.'
                      : page === 'incidents'
                        ? 'Reconstruct the sequence. Understand what went wrong.'
                        : page === 'integrations'
                          ? 'Add a sensor to your ecosystem in a few lines of code.'
                          : 'You control what is recorded, retained, and exported.'}
              </p>
            </div>
            <div className="heading-actions">
              {page === 'timeline' || (page === 'projects' && selectedProject) ? (
                <button className="button" onClick={() => setModal('logs')}>
                  <Plus size={15} />
                  Attach logs
                </button>
              ) : page === 'projects' ? (
                <button className="button" onClick={() => setModal('project')}>
                  <Plus size={15} />
                  Register project
                </button>
              ) : page === 'applications' ? (
                <button className="button" onClick={() => navigate('integrations')}>
                  <Plus size={15} />
                  Connect application
                </button>
              ) : null}
            </div>
          </div>
          {daemonAvailable === false && (
            <div className="offline-banner">
              <Unplug size={16} />
              <span>
                The local daemon is unavailable. Start it with <code>npm run dev</code>.
                Reconnecting automatically.
              </span>
              <button className="text-button" onClick={refreshRegistry}>
                Retry
              </button>
            </div>
          )}
          {page === 'timeline' && (
            <>
              <div className="telemetry-strip">
                <div className="telemetry-stat">
                  <span>RECORDED EVENTS</span>
                  <strong>
                    {health ? health.eventCount.toLocaleString() : '—'}
                    <Activity size={16} />
                  </strong>
                  <small>Stored on this machine</small>
                </div>
                <div className="telemetry-stat">
                  <span>CONNECTED APPS</span>
                  <strong>
                    {connectedApps.toString().padStart(2, '0')}
                    <Layers size={16} />
                  </strong>
                  <small>
                    {applications.length
                      ? `${applications.length} registered in the ecosystem`
                      : 'Ready for your first application'}
                  </small>
                </div>
                <div className="telemetry-stat">
                  <span>OPEN INCIDENTS</span>
                  <strong className={openIncidents ? 'amber-text' : ''}>
                    {openIncidents.toString().padStart(2, '0')}
                    <CircleAlert size={16} />
                  </strong>
                  <small>
                    {openIncidents ? 'Ready for investigation' : 'Nothing needs your attention'}
                  </small>
                </div>
                <SignalChart events={events} connected={connected} />
              </div>
              <section className="panel timeline-panel">
                <div className="panel-title">
                  <div>
                    <Radio size={15} />
                    <h2>Live activity</h2>
                    <span className="count-label">{total.toLocaleString()}</span>
                  </div>
                  <span className="subtle mono">NEWEST FIRST</span>
                </div>
                {timeline}
              </section>
              <div className="under-panel">
                <span>
                  <ShieldCheck size={13} />
                  Events stay local. Secrets are redacted before storage.
                </span>
                <button className="text-button" onClick={() => navigate('integrations')}>
                  View integration guide
                  <ArrowUpRight size={12} />
                </button>
              </div>
            </>
          )}
          {page === 'projects' &&
            (selectedProject ? (
              <>
                <button
                  className="text-button back-link"
                  onClick={() => {
                    setSelectedProject('');
                    setProjectView(null);
                  }}
                >
                  ← All projects
                </button>
                {projectView && <ProjectSummary data={projectView} />}
                <section className="panel timeline-panel">
                  <div className="panel-title">
                    <div>
                      <Activity size={15} />
                      <h2>Project activity</h2>
                    </div>
                    <span className="subtle mono">UNIFIED TIMELINE</span>
                  </div>
                  {timeline}
                </section>
              </>
            ) : (
              <div className="project-grid">
                {projects.length ? (
                  projects.map((project) => (
                    <button
                      className="project-card panel"
                      key={project.id}
                      onClick={() => selectProject(project.id)}
                    >
                      <div className="card-top">
                        <span className="square-icon">
                          <Folder size={20} />
                        </span>
                        <ArrowUpRight size={16} />
                      </div>
                      <h2>{project.name}</h2>
                      <p className="mono">{project.repo || project.paths[0] || project.id}</p>
                      <div className="project-card-footer">
                        <span>
                          {project.applications.length} linked{' '}
                          {project.applications.length === 1 ? 'tool' : 'tools'}
                        </span>
                        <span>
                          {project.environments.length
                            ? project.environments.join(', ')
                            : 'Local project'}
                        </span>
                      </div>
                    </button>
                  ))
                ) : (
                  <section className="panel full-width">
                    <Empty
                      icon={<Folder size={26} />}
                      title="Give your signals a shared identity"
                      text="Projects connect paths, repositories, and application events. Register one here, or identify a project through the SDK."
                    >
                      <button className="button primary" onClick={() => setModal('project')}>
                        <Plus size={14} />
                        Register project
                      </button>
                    </Empty>
                  </section>
                )}
              </div>
            ))}
          {page === 'applications' && (
            <Applications
              applications={applications}
              onConnect={() => navigate('integrations')}
              onAction={requestAction}
            />
          )}
          {page === 'incidents' && (
            <Incidents
              incidents={incidents}
              onOpen={setIncidentDetail}
              onTimeline={() => navigate('timeline')}
            />
          )}
          {page === 'integrations' && <IntegrationGuide onCopy={notify} connected={connected} />}
          {page === 'settings' && (
            <Settings
              onNotify={notify}
              health={health}
              onExport={exportEvents}
              onRefresh={() => {
                refreshRegistry();
                setRefresh((n) => n + 1);
              }}
            />
          )}
          <footer className="page-footer">
            <span>
              <Logo small />
              RIPPLEY LABS<span className="footer-divider">/</span>BUILT FOR THE THINGS YOU BUILD
            </span>
            <span>
              <kbd>⌘ K</kbd>Command palette
            </span>
          </footer>
        </div>
      </main>
      {toast && (
        <div role="status" className={`toast ${toast.error ? 'error' : ''}`}>
          {toast.error ? <CircleAlert size={16} /> : <Check size={16} />}
          <span>{toast.text}</span>
          <button
            className="icon-button"
            onClick={() => setToast(null)}
            aria-label="Dismiss notification"
          >
            <X size={14} />
          </button>
        </div>
      )}
      {activeCommand && (
        <div className={`command-status ${activeCommand.status}`}>
          <div>
            {['pending', 'accepted'].includes(activeCommand.status) ? (
              <Loader2 className="spin" size={15} />
            ) : activeCommand.status === 'completed' ? (
              <Check size={15} />
            ) : (
              <CircleAlert size={15} />
            )}
            <strong>{activeCommand.command}</strong>
            <Badge tone={activeCommand.status === 'completed' ? 'success' : ''}>
              {activeCommand.status}
            </Badge>
            <button
              className="icon-button"
              onClick={() => setActiveCommand(null)}
              aria-label="Dismiss command status"
            >
              <X size={13} />
            </button>
          </div>
          {activeCommand.error && <p>{activeCommand.error}</p>}
          {activeCommand.result !== undefined && (
            <pre>{JSON.stringify(activeCommand.result, null, 2)}</pre>
          )}
        </div>
      )}
      {modal === 'logs' && (
        <LogModal
          projects={projects}
          onClose={() => setModal(null)}
          onDone={(count) => {
            setModal(null);
            notify(`${count} log ${count === 1 ? 'line' : 'lines'} recorded`);
            setRefresh((n) => n + 1);
            refreshRegistry();
          }}
        />
      )}
      {modal === 'project' && (
        <ProjectModal
          onClose={() => setModal(null)}
          onDone={(project) => {
            setModal(null);
            refreshRegistry();
            selectProject(project.id);
            notify('Project registered');
          }}
        />
      )}
      {modal === 'palette' && (
        <CommandPalette
          onClose={() => setModal(null)}
          navigate={navigate}
          projects={projects}
          onProject={selectProject}
          onLogs={() => setModal('logs')}
          onExport={exportEvents}
        />
      )}
      {confirmation && (
        <Modal
          title={confirmation.title}
          eyebrow="CONFIRM APPLICATION COMMAND"
          onClose={() => setConfirmation(null)}
        >
          <div className="modal-body">
            <p>
              This will ask{' '}
              <strong>{appName(confirmation.input.provider || 'the registered provider')}</strong>{' '}
              to run <code>{confirmation.input.command}</code>.
            </p>
            <p className="muted">
              This action may interrupt a running process or change your project. Review the request
              before continuing.
            </p>
            <pre className="code-block">
              {JSON.stringify(confirmation.input.payload || {}, null, 2)}
            </pre>
          </div>
          <div className="modal-footer">
            <button className="button" onClick={() => setConfirmation(null)}>
              Cancel
            </button>
            <button
              className="button danger"
              onClick={() => routeCommand({ ...confirmation.input, confirmed: true })}
            >
              Confirm and run
              <ArrowRight size={14} />
            </button>
          </div>
        </Modal>
      )}
      {contextEvent && (
        <div
          className="drawer-backdrop"
          onMouseDown={(e) => {
            if (e.currentTarget === e.target) setContextEvent(null);
          }}
        >
          <aside
            ref={contextDrawerRef}
            tabIndex={-1}
            className="context-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="What the hell happened?"
          >
            <header>
              <div>
                <span className="eyebrow orange">CONNECTING THE DOTS</span>
                <h2>What the hell happened?</h2>
              </div>
              <button
                className="icon-button"
                onClick={() => setContextEvent(null)}
                aria-label="Close context"
              >
                <X size={19} />
              </button>
            </header>
            <div className="drawer-scroll">
              <div className="context-anchor">
                <Badge tone={contextEvent.severity}>{contextEvent.severity}</Badge>
                <span className="mono">{contextEvent.type}</span>
                <h3>{contextEvent.message}</h3>
                <p>
                  {projectName(contextEvent)}
                  <span>·</span>
                  {shortDate(contextEvent.timestamp)} at {time(contextEvent.timestamp)}
                </p>
              </div>
              {contextLoading ? (
                <div className="loading-state">
                  <Loader2 size={19} className="spin" />
                  Reconstructing activity…
                </div>
              ) : context ? (
                <>
                  <div className="analysis-summary">
                    <div>
                      <Waypoints size={16} />
                      <span>THE RECONSTRUCTION</span>
                      <Badge>DETERMINISTIC</Badge>
                    </div>
                    <p>{context.summary}</p>
                  </div>
                  <div className="context-reasons">
                    {context.reasons.map((reason, i) => (
                      <span key={i}>
                        <Check size={12} />
                        {reason}
                      </span>
                    ))}
                  </div>
                  <div className="section-kicker">
                    {context.events.length} CORRELATED EVENTS<span>CHRONOLOGICAL</span>
                  </div>
                  <div className="context-events">
                    {[...context.events]
                      .sort(
                        (a, b) =>
                          Date.parse(a.timestamp) - Date.parse(b.timestamp) ||
                          a.sequence - b.sequence,
                      )
                      .map((event) => (
                        <div
                          key={event.id}
                          className={`context-event ${event.id === contextEvent.id ? 'anchor' : ''}`}
                        >
                          <span className={`event-dot ${event.severity}`} />
                          <div>
                            <span className="mono context-time">
                              {time(event.timestamp)} <strong>{appName(event.source.app)}</strong>
                            </span>
                            <p>{event.message}</p>
                            <span className="mono subtle">{event.type}</span>
                          </div>
                        </div>
                      ))}
                  </div>
                  <div className="context-disclaimer">
                    <CircleAlert size={13} />
                    Correlated activity shows a sequence of events, not a proven root cause.
                  </div>
                </>
              ) : (
                <div className="form-error">{contextError || 'Context is unavailable.'}</div>
              )}
            </div>
            <div className="drawer-footer">
              <button className="button" onClick={() => setContextEvent(null)}>
                Close
              </button>
              <button
                className="button primary"
                disabled={!context}
                onClick={() => createIncident(contextEvent)}
              >
                <Plus size={14} />
                Save as incident
              </button>
            </div>
          </aside>
        </div>
      )}
      {incidentDetail && (
        <IncidentModal
          incident={incidentDetail}
          onClose={() => setIncidentDetail(null)}
          onChange={(incident) => {
            setIncidentDetail(incident);
            refreshRegistry();
          }}
          onNotify={notify}
        />
      )}
    </div>
  );
}

function SignalChart({ events, connected }: { events: StoredEvent[]; connected: boolean }) {
  const bins = useMemo(() => {
    const buckets = Array.from({ length: 36 }, () => 0);
    const now = Date.now();
    for (const event of events) {
      const hours = (now - new Date(event.timestamp).getTime()) / 3600000;
      if (hours >= 0 && hours < 24) buckets[Math.min(35, Math.floor((24 - hours) * 1.5))]++;
    }
    return buckets;
  }, [events]);
  const max = Math.max(...bins, 1);
  return (
    <div className="signal-chart">
      <div>
        <span>RECENT SIGNAL</span>
        <span className="mono">24H / LOADED EVENTS</span>
      </div>
      <div
        className={`spark-bars ${events.length ? 'has-events' : ''}`}
        aria-label={`${events.length} loaded events across the last 24 hours`}
      >
        {bins.map((count, index) => (
          <i
            key={index}
            style={{
              height: `${Math.max(3, (count / max) * 35)}px`,
              opacity: count ? 0.55 + (count / max) * 0.45 : 0.3,
            }}
            title={`${count} events`}
          />
        ))}
      </div>
      <small>
        <span className={`status-dot ${connected ? 'green' : ''}`} />
        {connected ? 'Live stream established' : 'Waiting for connection'}
      </small>
    </div>
  );
}

function EventRow({
  event,
  expanded,
  groupContinuation,
  onExpand,
  onExplain,
  onIncident,
  onAction,
  onProject,
  onCopy,
}: {
  event: StoredEvent;
  expanded: boolean;
  groupContinuation: boolean;
  onExpand: () => void;
  onExplain: () => void;
  onIncident: () => void;
  onAction: (action: EventAction) => void;
  onProject: () => void;
  onCopy: () => void;
}) {
  return (
    <div
      className={`event-wrapper ${expanded ? 'expanded' : ''} ${groupContinuation ? 'group-continuation' : ''}`}
    >
      <div
        className="event-row"
        onClick={onExpand}
        tabIndex={0}
        role="button"
        aria-expanded={expanded}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onExpand();
          }
        }}
      >
        <div className="event-time">
          <span className={`event-dot ${event.severity}`} />
          <span>
            {time(event.timestamp)}
            <small>{shortDate(event.timestamp)}</small>
          </span>
        </div>
        <div className="event-main">
          <div>
            <span className="event-source">{appName(event.source.app)}</span>
            <span className="event-type">{event.type}</span>
            {groupContinuation && (
              <Waypoints
                size={12}
                className="correlation-icon"
                aria-label="Related to previous event"
              />
            )}
          </div>
          <p>{event.message || '(empty message)'}</p>
        </div>
        <div className="event-project">
          <Folder size={12} />
          <span>{projectName(event)}</span>
        </div>
        <div>
          <Badge tone={event.severity}>{event.severity}</Badge>
        </div>
        <ChevronRight size={14} className={`expand-chevron ${expanded ? 'rotated' : ''}`} />
      </div>
      {expanded && (
        <div className="event-details">
          <div className="event-detail-toolbar">
            <button className="button explain-button" onClick={onExplain}>
              <Waypoints size={14} />
              What the hell happened?
              <ArrowUpRight size={12} />
            </button>
            <button className="button quiet" onClick={onIncident}>
              <Plus size={13} />
              Save as incident
            </button>
            <button className="icon-button" aria-label="Copy event JSON" onClick={onCopy}>
              <Clipboard size={14} />
            </button>
          </div>
          <div className="event-metadata">
            <span>
              <b>EVENT</b>
              <code>{event.id}</code>
            </span>
            {event.correlationId && (
              <span>
                <b>CORRELATION</b>
                <code>{event.correlationId}</code>
              </span>
            )}
            {event.project && (
              <span>
                <b>PROJECT</b>
                <button className="text-button" onClick={onProject}>
                  {projectName(event)}
                  <ArrowUpRight size={11} />
                </button>
              </span>
            )}
            <span>
              <b>SCHEMA</b>
              <code>v{event.schemaVersion}</code>
            </span>
          </div>
          {event.tags.length > 0 && (
            <div className="event-tags">
              {event.tags.map((tag) => (
                <Badge key={tag}>#{tag}</Badge>
              ))}
            </div>
          )}
          <details className="payload" open>
            <summary>
              Structured payload<span>JSON</span>
            </summary>
            <pre>
              {JSON.stringify(
                {
                  data: event.data,
                  metadata: event.metadata,
                  ...(event.parentEventId ? { parentEventId: event.parentEventId } : {}),
                },
                null,
                2,
              )}
            </pre>
          </details>
          {event.actions.length > 0 && (
            <div className="suggested-actions">
              <span className="eyebrow">AVAILABLE ACTIONS</span>
              <div>
                {event.actions.map((action) => (
                  <button key={action.id} className="button" onClick={() => onAction(action)}>
                    <Play size={12} />
                    {action.label}
                    <span className="action-provider">{appName(action.provider)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ProjectSummary({ data }: { data: ProjectView }) {
  const { project, stats } = data;
  const lastCommand =
    typeof stats.lastCommand === 'string' ? stats.lastCommand : stats.lastCommand?.message;
  const deployment =
    typeof stats.lastDeployment === 'string'
      ? stats.lastDeployment
      : stats.lastDeployment?.timestamp;
  return (
    <section className="panel project-summary">
      <div className="project-identity">
        <span className="square-icon">
          <Folder size={23} />
        </span>
        <div>
          <h2>
            {project.name}
            <Badge
              tone={
                stats.status === 'healthy' ? 'success' : stats.status === 'error' ? 'error' : ''
              }
            >
              {stats.status}
            </Badge>
          </h2>
          <span className="mono subtle">{project.repo || project.paths[0] || project.id}</span>
        </div>
      </div>
      <div className="project-stats">
        <div>
          <span>RUNNING PROCESSES</span>
          <strong>
            {Array.isArray(stats.runningProcesses)
              ? stats.runningProcesses.length
              : stats.runningProcesses}
          </strong>
        </div>
        <div>
          <span>OPEN PORTS</span>
          <strong className="mono small-value">
            {stats.ports.length ? stats.ports.join(', ') : 'None recorded'}
          </strong>
        </div>
        <div>
          <span>ENVIRONMENT</span>
          <strong className={stats.environmentWarnings ? 'amber-text small-value' : 'small-value'}>
            {stats.environmentWarnings} warnings
          </strong>
        </div>
        <div>
          <span>ERRORS TODAY</span>
          <strong className={stats.errorsToday ? 'red-text' : ''}>{stats.errorsToday}</strong>
        </div>
      </div>
      <div className="project-info">
        <span>
          <Terminal size={13} />
          {lastCommand || 'No commands recorded'}
        </span>
        <span>
          <GitBranch size={13} />
          {deployment
            ? `Last deployment ${Number.isNaN(Date.parse(deployment)) ? deployment : ago(deployment)}`
            : 'No deployment recorded'}
        </span>
        <span>
          <Layers size={13} />
          {stats.connectedTools?.length
            ? stats.connectedTools.map(appName).join(', ')
            : 'No connected tools'}
        </span>
      </div>
      {project.paths.length > 0 && (
        <div className="project-path mono">{project.paths.join(' · ')}</div>
      )}
    </section>
  );
}

function Applications({
  applications,
  onConnect,
  onAction,
}: {
  applications: ApplicationRecord[];
  onConnect: () => void;
  onAction: (action: EventAction) => void;
}) {
  return (
    <>
      <div className="section-heading">
        <span>{applications.length} REGISTERED APPLICATIONS</span>
        <span className="subtle">
          <span className="status-dot green" />
          {applications.filter((a) => a.connected).length} connected
        </span>
      </div>
      {!applications.length ? (
        <section className="panel">
          <Empty
            icon={<Network size={27} />}
            title="Your ecosystem starts with one connection"
            text="Applications register through the SDK and advertise their health, subscriptions, and capabilities. They'll appear here automatically."
          >
            <button className="button primary" onClick={onConnect}>
              <Plus size={14} />
              Connect an application
            </button>
          </Empty>
        </section>
      ) : (
        <div className="application-grid">
          {applications.map((app) => (
            <section className="panel application-card" key={app.id}>
              <div className="application-top">
                <span className="square-icon">
                  <Box size={21} />
                </span>
                <Badge
                  tone={app.connected ? (app.health === 'healthy' ? 'success' : app.health) : ''}
                >
                  <span className="status-dot" />
                  {app.connected ? app.health : 'disconnected'}
                </Badge>
              </div>
              <h2>{app.name}</h2>
              <div className="app-version mono">
                {app.id}
                <span>v{app.version}</span>
              </div>
              <div className="application-separator" />
              <div className="app-details">
                <span>
                  LAST HEARTBEAT<strong>{ago(app.lastHeartbeat)}</strong>
                </span>
                <span>
                  EVENT SUBSCRIPTIONS<strong>{app.subscriptions.length}</strong>
                </span>
                <span>
                  CAPABILITIES<strong>{app.capabilities.length}</strong>
                </span>
              </div>
              {app.subscriptions.length > 0 && (
                <div className="subscription-tags">
                  {app.subscriptions.map((sub) => (
                    <Badge key={sub}>{sub}</Badge>
                  ))}
                </div>
              )}
              {app.capabilities.length > 0 && (
                <div className="capabilities">
                  <div className="eyebrow">REGISTERED CAPABILITIES</div>
                  {app.capabilities.map((capability) => (
                    <button
                      key={capability.name}
                      disabled={!app.connected}
                      title={capability.description || capability.name}
                      onClick={() =>
                        onAction({
                          id: capability.name,
                          label: capability.name,
                          provider: app.id,
                          command: capability.name,
                          payload: {},
                          requiresConfirmation: true,
                        })
                      }
                    >
                      <code>{capability.name}</code>
                      <Play size={12} />
                    </button>
                  ))}
                </div>
              )}
              {app.actions.length > 0 && (
                <div className="app-actions">
                  {app.actions.map((action) => (
                    <button
                      className="button"
                      key={action.id}
                      disabled={!app.connected}
                      onClick={() => onAction(action)}
                    >
                      {action.label}
                      <ArrowUpRight size={12} />
                    </button>
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
      )}
      <div className="note-panel">
        <Waypoints size={19} />
        <div>
          <h3>Shared contracts. Independent applications.</h3>
          <p>
            Each tool connects to Black Box directly. Events and capabilities work across your
            ecosystem without applications depending on each other.
          </p>
        </div>
      </div>
    </>
  );
}

function Incidents({
  incidents,
  onOpen,
  onTimeline,
}: {
  incidents: Incident[];
  onOpen: (incident: Incident) => void;
  onTimeline: () => void;
}) {
  const [filter, setFilter] = useState('all');
  const filtered = incidents.filter((i) => filter === 'all' || i.status === filter);
  return (
    <section className="panel">
      <div className="panel-title">
        <div className="tab-list">
          {['all', 'open', 'resolved'].map((status) => (
            <button
              key={status}
              className={filter === status ? 'active' : ''}
              onClick={() => setFilter(status)}
            >
              {status === 'all' ? 'All incidents' : status}
              <span>{incidents.filter((i) => status === 'all' || i.status === status).length}</span>
            </button>
          ))}
        </div>
      </div>
      {!filtered.length ? (
        <Empty
          icon={<ShieldCheck size={28} />}
          title={
            incidents.length ? 'Nothing here right now' : 'A clear picture when things go sideways'
          }
          text="Select an event in the timeline, reconstruct what happened, and preserve the correlated activity as an incident."
        >
          <button className="button" onClick={onTimeline}>
            <Activity size={14} />
            Explore the timeline
          </button>
        </Empty>
      ) : (
        <div className="incident-list">
          {filtered.map((incident) => (
            <button className="incident-row" key={incident.id} onClick={() => onOpen(incident)}>
              <span className={`incident-icon ${incident.status}`}>
                {incident.status === 'resolved' ? <Check size={17} /> : <CircleAlert size={17} />}
              </span>
              <div>
                <h3>{incident.title}</h3>
                <p>{incident.summary}</p>
                <span>{incident.sources.map(appName).join(' · ')}</span>
              </div>
              <div className="incident-meta">
                <Badge tone={incident.status === 'resolved' ? 'success' : 'warning'}>
                  {incident.status}
                </Badge>
                <span>
                  {incident.eventIds.length} events · {ago(incident.startedAt)}
                </span>
              </div>
              <ChevronRight size={15} />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function IntegrationGuide({
  onCopy,
  connected,
}: {
  onCopy: (text: string, error?: boolean) => void;
  connected: boolean;
}) {
  const copy = (text: string) =>
    navigator.clipboard
      .writeText(text)
      .then(() => onCopy('Copied to clipboard'))
      .catch(() => onCopy('Clipboard is unavailable', true));
  return (
    <div className="integration-layout">
      <div>
        <section className="panel integration-panel">
          <div className="panel-title">
            <div>
              <Code2 size={16} />
              <h2>The first signal</h2>
            </div>
            <Badge>TYPESCRIPT SDK</Badge>
          </div>
          <div className="integration-steps">
            <div className="integration-step">
              <span>01</span>
              <div>
                <h3>Add the shared package</h3>
                <p>
                  The SDK lives in this workspace. Build and pack both shared packages, then install
                  them together in your application.
                </p>
                <div className="command-line">
                  <code style={{ whiteSpace: 'pre-wrap' }}>{packageCommand}</code>
                  <button
                    className="icon-button"
                    aria-label="Copy build command"
                    onClick={() => copy(packageCommand)}
                  >
                    <Clipboard size={14} />
                  </button>
                </div>
                <div className="command-line">
                  <code style={{ overflowWrap: 'anywhere' }}>{installCommand}</code>
                  <button
                    className="icon-button"
                    aria-label="Copy install command"
                    onClick={() => copy(installCommand)}
                  >
                    <Clipboard size={14} />
                  </button>
                </div>
                <p className="micro">
                  Run the install command from your application. Replace the path with your Black
                  Box checkout.
                </p>
              </div>
            </div>
            <div className="integration-step">
              <span>02</span>
              <div>
                <h3>Tell Black Box something happened</h3>
                <p>No API keys. No accounts. The client discovers your local daemon.</p>
                <div className="code-window">
                  <div>
                    <span>
                      <i />
                      <i />
                      <i />
                    </span>
                    <span>your-app.ts</span>
                    <button
                      className="icon-button"
                      aria-label="Copy integration code"
                      onClick={() => copy(integrationCode)}
                    >
                      <Clipboard size={13} />
                    </button>
                  </div>
                  <pre>{integrationCode}</pre>
                </div>
              </div>
            </div>
            <div className="integration-step">
              <span>03</span>
              <div>
                <h3>Watch the story come together</h3>
                <p>
                  Events appear in the timeline as they arrive. Add a project identity and
                  correlation ID to connect signals across your applications.
                </p>
              </div>
            </div>
          </div>
        </section>
        <div className="note-panel">
          <ShieldCheck size={20} />
          <div>
            <h3>Your application always comes first.</h3>
            <p>
              The SDK fails gracefully when Black Box is unavailable and can buffer events for later
              delivery. Your application keeps working.
            </p>
          </div>
        </div>
      </div>
      <aside className="integration-aside">
        <section className="panel">
          <div className="section-kicker">
            LOCAL TRANSPORT
            <Radio size={14} />
          </div>
          <span className={`connection-pill ${connected ? 'online' : 'offline'}`}>
            <span className="status-dot" />
            {connected ? 'Ready to receive' : 'Waiting for daemon'}
          </span>
          <label>DEFAULT ENDPOINT</label>
          <code>http://127.0.0.1:47821</code>
          <label>PUBLISH EVENTS</label>
          <code>POST /events</code>
          <label>SUBSCRIBE TO EVENTS</label>
          <code>WS /stream</code>
          <label>PROTOCOL</label>
          <code>Rippley Event Protocol v1.0</code>
        </section>
        <section className="panel">
          <div className="section-kicker">ONE CONTRACT. EVERY TOOL.</div>
          {[
            { name: 'Port Authority', text: 'Processes & ports', icon: Network },
            { name: 'Pit Boss', text: 'Commands & deployments', icon: Terminal },
            { name: 'Env Reaper', text: 'Environment & configuration', icon: SlidersHorizontal },
          ].map(({ name, text, icon: Icon }) => (
            <div className="integration-tool" key={name}>
              <Icon size={17} />
              <div>
                <strong>{name}</strong>
                <span>{text}</span>
              </div>
            </div>
          ))}
          <p className="micro">
            Working adapters and capability registrations are included in{' '}
            <code>examples/port-authority.ts, pit-boss.ts, env-reaper.ts</code>.
          </p>
        </section>
      </aside>
    </div>
  );
}

function LogModal({
  projects,
  onClose,
  onDone,
}: {
  projects: ProjectRecord[];
  onClose: () => void;
  onDone: (count: number) => void;
}) {
  const [source, setSource] = useState('manual');
  const [project, setProject] = useState('');
  const [stream, setStream] = useState('file');
  const [lines, setLines] = useState('');
  const [filename, setFilename] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    if (
      new TextEncoder().encode(lines).length > 900 * 1024 ||
      lines.split(/\r?\n/).filter((line) => line.trim()).length > 500
    ) {
      setError(
        'Attach up to 500 non-empty lines and 900 KB at a time. Use the SDK for larger log streams.',
      );
      setBusy(false);
      return;
    }
    try {
      const identity = projects.find((p) => p.id === project);
      const result = await post<{ events: StoredEvent[] }>('/logs', {
        source: { app: source },
        ...(identity ? { project: { id: identity.id, name: identity.name } } : {}),
        stream,
        lines,
      });
      onDone(result.events.length);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Attach a log source" eyebrow="INGEST INTO THE RECORDER" onClose={onClose} wide>
      <form onSubmit={submit}>
        <div className="modal-body">
          <p className="muted">
            Paste output or select a text / JSON log file. Each line becomes a searchable event,
            with secrets redacted before storage. Up to 500 lines / 900 KB per attachment.
          </p>
          <div className="form-grid">
            <label>
              Source application
              <input
                data-autofocus
                required
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder="my-application"
              />
            </label>
            <label>
              Project
              <select value={project} onChange={(e) => setProject(e.target.value)}>
                <option value="">No project</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            Log stream
            <select value={stream} onChange={(e) => setStream(e.target.value)}>
              <option value="file">Log file</option>
              <option value="stdout">Standard output (stdout)</option>
              <option value="stderr">Standard error (stderr)</option>
            </select>
          </label>
          <div className="textarea-heading">
            <label htmlFor="log-content">Log content</label>
            <label className="file-picker">
              <Upload size={13} />
              {filename || 'Choose file'}
              <input
                type="file"
                accept=".txt,.log,.json,.jsonl,.ndjson,text/*,application/json"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  if (file.size > 900 * 1024) {
                    setError('Use a log file smaller than 900 KB. Larger streams can use the SDK.');
                    return;
                  }
                  setFilename(file.name);
                  setLines(await file.text());
                }}
              />
            </label>
          </div>
          <textarea
            id="log-content"
            required
            value={lines}
            onChange={(e) => setLines(e.target.value)}
            placeholder={
              '[info] Development server listening on :5173\n{"level":"error","message":"Connection refused"}'
            }
            rows={10}
          />
          {error && <p className="form-error">{error}</p>}
        </div>
        <div className="modal-footer">
          <span className="micro">
            <ShieldCheck size={12} />
            Stored locally
          </span>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" type="submit" disabled={busy || !lines.trim()}>
            {busy ? <Loader2 size={14} className="spin" /> : <Upload size={14} />}Record logs
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ProjectModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (project: ProjectRecord) => void;
}) {
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [path, setPath] = useState('');
  const [repo, setRepo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal title="Register a project" eyebrow="ONE SHARED IDENTITY" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const result = await post<{ project: ProjectRecord }>('/projects', {
              id,
              name,
              paths: path.trim() ? [path.trim()] : [],
              ...(repo.trim() ? { repo: repo.trim() } : {}),
            });
            onDone(result.project);
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="modal-body">
          <p className="muted">
            Link a project name, local path, and repository so every tool speaks the same language.
          </p>
          <label>
            Display name
            <input
              data-autofocus
              required
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setId(
                  e.target.value
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, '-')
                    .replace(/^-|-$/g, ''),
                );
              }}
              placeholder="Save Scum"
            />
          </label>
          <label>
            Stable project ID
            <input
              required
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="save-scum"
            />
          </label>
          <label>
            Local path <span className="muted">optional</span>
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/Code/save-scum"
            />
          </label>
          <label>
            Repository <span className="muted">optional</span>
            <input
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="Rippley777/save-scum"
            />
          </label>
          {error && <p className="form-error">{error}</p>}
        </div>
        <div className="modal-footer">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" type="submit" disabled={busy}>
            {busy ? <Loader2 size={14} className="spin" /> : <Plus size={14} />}Register project
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CommandPalette({
  onClose,
  navigate,
  projects,
  onProject,
  onLogs,
  onExport,
}: {
  onClose: () => void;
  navigate: (page: Page) => void;
  projects: ProjectRecord[];
  onProject: (id: string) => void;
  onLogs: () => void;
  onExport: () => void;
}) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, true, onClose);
  const commands = [
    {
      label: 'Go to event timeline',
      icon: Activity,
      run: () => navigate('timeline'),
      category: 'NAVIGATE',
    },
    {
      label: 'Browse projects',
      icon: Folder,
      run: () => navigate('projects'),
      category: 'NAVIGATE',
    },
    {
      label: 'Connected applications',
      icon: Layers,
      run: () => navigate('applications'),
      category: 'NAVIGATE',
    },
    {
      label: 'Open incidents',
      icon: CircleAlert,
      run: () => navigate('incidents'),
      category: 'NAVIGATE',
    },
    {
      label: 'Connect an application',
      icon: Waypoints,
      run: () => navigate('integrations'),
      category: 'ACTIONS',
    },
    { label: 'Attach logs', icon: Upload, run: onLogs, category: 'ACTIONS' },
    { label: 'Export filtered events', icon: ArrowDownToLine, run: onExport, category: 'ACTIONS' },
    {
      label: 'Retention & settings',
      icon: Settings2,
      run: () => navigate('settings'),
      category: 'NAVIGATE',
    },
    ...projects.map((p) => ({
      label: p.name,
      icon: Folder,
      run: () => onProject(p.id),
      category: 'PROJECTS',
    })),
  ].filter((c) => c.label.toLowerCase().includes(search.toLowerCase()));
  const execute = (index: number) => {
    const command = commands[index];
    if (!command) return;
    onClose();
    command.run();
  };
  return (
    <div
      className="modal-backdrop palette-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="command-palette"
        role="dialog"
        aria-label="Command palette"
        aria-modal="true"
      >
        <div className="palette-search">
          <Search size={20} />
          <input
            data-autofocus
            placeholder="Where do you want to go?"
            aria-label="Search commands"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setSelected(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSelected((i) => Math.min(commands.length - 1, i + 1));
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSelected((i) => Math.max(0, i - 1));
              }
              if (e.key === 'Enter') {
                e.preventDefault();
                execute(selected);
              }
            }}
          />
          <kbd>ESC</kbd>
        </div>
        <div className="palette-options">
          {commands.length ? (
            commands.map((command, index) => (
              <button
                key={command.label}
                className={index === selected ? 'selected' : ''}
                onMouseEnter={() => setSelected(index)}
                onClick={() => execute(index)}
              >
                <command.icon size={16} />
                <span>{command.label}</span>
                <small>{command.category}</small>
                {selected === index && <span>↵</span>}
              </button>
            ))
          ) : (
            <p>No matching commands</p>
          )}
        </div>
        <div className="palette-footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd>to navigate
          </span>
          <span>
            <kbd>↵</kbd>to select
          </span>
          <Logo small />
        </div>
      </div>
    </div>
  );
}

function Settings({
  onNotify,
  health,
  onExport,
  onRefresh,
}: {
  onNotify: (text: string, error?: boolean) => void;
  health: Health | null;
  onExport: () => void;
  onRefresh: () => void;
}) {
  const [retention, setRetention] = useState<RetentionPolicy>(DEFAULT_RETENTION);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cleanup, setCleanup] = useState(false);
  useEffect(() => {
    api<{ retention: RetentionPolicy }>('/settings')
      .then((result) => {
        setRetention(result.retention);
        setLoaded(true);
      })
      .catch((e) => onNotify(e.message, true));
  }, [onNotify]);
  return (
    <div className="settings-layout">
      <section className="panel settings-panel">
        <div className="panel-title">
          <div>
            <Database size={16} />
            <h2>Event retention</h2>
          </div>
          <Badge>LOCAL DATABASE</Badge>
        </div>
        <div className="settings-body">
          <p>
            Keep the detail you need. Expired events are removed according to each severity's
            retention policy.
          </p>
          {severities.map((severity) => (
            <div className="retention-row" key={severity}>
              <div>
                <span className={`event-dot ${severity}`} />
                <strong>{severity}</strong>
              </div>
              <select
                aria-label={`${severity} retention`}
                disabled={!loaded}
                value={retention[severity] === null ? 'forever' : String(retention[severity])}
                onChange={(e) =>
                  setRetention((old) => ({
                    ...old,
                    [severity]: e.target.value === 'forever' ? null : Number(e.target.value),
                  }))
                }
              >
                {retention[severity] !== null &&
                  ![1, 7, 30, 90, 365].includes(retention[severity]!) && (
                    <option value={String(retention[severity])}>{retention[severity]} days</option>
                  )}
                <option value="1">1 day</option>
                <option value="7">7 days</option>
                <option value="30">30 days</option>
                <option value="90">90 days</option>
                <option value="365">1 year</option>
                <option value="forever">Keep indefinitely</option>
              </select>
            </div>
          ))}
          <div className="settings-actions">
            <button className="button" disabled={!loaded} onClick={() => setCleanup(true)}>
              Run cleanup
            </button>
            <button
              className="button primary"
              disabled={!loaded || busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await patch('/settings', { retention });
                  onNotify('Retention policy saved');
                } catch (e) {
                  onNotify((e as Error).message, true);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? <Loader2 className="spin" size={14} /> : <Check size={14} />}Save policy
            </button>
          </div>
        </div>
      </section>
      <div>
        <section className="panel privacy-panel">
          <ShieldCheck size={23} />
          <h2>Private by architecture.</h2>
          <p>
            Events are stored in SQLite on this machine. Sensitive values are redacted before they
            reach storage or subscribers.
          </p>
          <div>
            <span>Remote synchronization</span>
            <Badge>OFF</Badge>
          </div>
          <div>
            <span>Cloud telemetry</span>
            <Badge>OFF</Badge>
          </div>
          <div>
            <span>Automatic secret redaction</span>
            <Badge tone="success">ACTIVE</Badge>
          </div>
        </section>
        <section className="panel export-panel">
          <div className="section-kicker">
            TAKE YOUR DATA WITH YOU
            <ArrowDownToLine size={15} />
          </div>
          <p>Export the current timeline filters as redacted newline-delimited JSON.</p>
          <button className="button" onClick={onExport}>
            <ArrowDownToLine size={14} />
            Export events
          </button>
        </section>
        <section className="panel daemon-details">
          <div className="section-kicker">RECORDER DETAILS</div>
          <p>
            <span>Version</span>
            <code>{health?.version || '—'}</code>
          </p>
          <p>
            <span>Protocol</span>
            <code>1.0</code>
          </p>
          <p>
            <span>Uptime</span>
            <code>
              {health
                ? `${Math.floor(health.uptime / 60)}m ${Math.floor(health.uptime % 60)}s`
                : '—'}
            </code>
          </p>
          <p>
            <span>Recorded events</span>
            <code>{health?.eventCount.toLocaleString() || '0'}</code>
          </p>
        </section>
      </div>
      {cleanup && (
        <Modal
          title="Remove expired events?"
          eyebrow="LOCAL DATABASE MAINTENANCE"
          onClose={() => setCleanup(false)}
        >
          <div className="modal-body">
            <p>
              This permanently deletes events older than your saved retention policy. Save policy
              changes before running cleanup.
            </p>
            <p className="muted">Export any events you want to keep first.</p>
          </div>
          <div className="modal-footer">
            <button className="button" onClick={() => setCleanup(false)}>
              Cancel
            </button>
            <button
              className="button danger"
              onClick={async () => {
                try {
                  const result = await post<{ deleted: number }>('/maintenance', {});
                  onNotify(`${result.deleted} expired events removed`);
                  setCleanup(false);
                  onRefresh();
                } catch (e) {
                  onNotify((e as Error).message, true);
                }
              }}
            >
              Remove expired events
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function IncidentModal({
  incident,
  onClose,
  onChange,
  onNotify,
}: {
  incident: Incident;
  onClose: () => void;
  onChange: (incident: Incident) => void;
  onNotify: (text: string, error?: boolean) => void;
}) {
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    Promise.allSettled(
      incident.eventIds.map((id) => api<{ event: StoredEvent }>(`/events/${id}`)),
    ).then((results) => {
      if (!active) return;
      setEvents(
        results
          .flatMap((result) => (result.status === 'fulfilled' ? [result.value.event] : []))
          .sort(
            (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.sequence - b.sequence,
          ),
      );
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [incident.id]);
  return (
    <Modal title={incident.title} eyebrow="INCIDENT RECORD" onClose={onClose} wide>
      <div className="modal-body incident-detail">
        <div className="incident-detail-meta">
          <Badge tone={incident.status === 'resolved' ? 'success' : 'warning'}>
            {incident.status}
          </Badge>
          <span>
            {shortDate(incident.startedAt)} at {time(incident.startedAt)}
          </span>
          <span>{incident.eventIds.length} events</span>
        </div>
        <div className="analysis-summary">
          <p>{incident.summary}</p>
        </div>
        <div className="section-kicker">CORRELATED ACTIVITY</div>
        {loading ? (
          <div className="loading-state">
            <Loader2 className="spin" size={18} />
            Reading context…
          </div>
        ) : (
          <div className="context-events">
            {events.map((event) => (
              <div key={event.id} className="context-event">
                <span className={`event-dot ${event.severity}`} />
                <div>
                  <span className="mono context-time">
                    {time(event.timestamp)} <strong>{appName(event.source.app)}</strong>
                  </span>
                  <p>{event.message}</p>
                  <span className="mono subtle">{event.type}</span>
                </div>
              </div>
            ))}
          </div>
        )}
        {!loading && events.length < incident.eventIds.length && (
          <p className="micro">
            Some original events are no longer retained. The incident summary remains available.
          </p>
        )}
      </div>
      <div className="modal-footer">
        <button className="button" onClick={onClose}>
          Close
        </button>
        <button
          className="button primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const { incident: updated } = await patch<{ incident: Incident }>(
                `/incidents/${incident.id}`,
                { status: incident.status === 'open' ? 'resolved' : 'open' },
              );
              onChange(updated);
              onNotify(updated.status === 'resolved' ? 'Incident resolved' : 'Incident reopened');
            } catch (e) {
              onNotify((e as Error).message, true);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Loader2 className="spin" size={14} /> : <Check size={14} />}
          {incident.status === 'open' ? 'Resolve incident' : 'Reopen incident'}
        </button>
      </div>
    </Modal>
  );
}
