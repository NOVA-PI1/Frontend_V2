import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  clearAuthToken,
  consumeAuthParams,
  createSession,
  getApiBaseUrl,
  getAuthProviders,
  getAuthToken,
  getCurrentUser,
  getGoogleLoginUrl,
  getHealth,
  getSession,
  listSessions,
  setAuthToken,
} from './api';
import { createSocket, isBusEvent } from './socket';
import type {
  AgentResult,
  AuthProvidersResponse,
  AuthUser,
  BusEvent,
  ChatMessage,
  HealthResponse,
  SessionResponse,
  SessionSummary,
} from './types';

type WorkMode = 'think' | 'do';
type SessionAgent = 'editorial' | 'etico' | 'dialectico' | 'multimodal';

const AGENT_ORDER: SessionAgent[] = ['editorial', 'etico', 'dialectico', 'multimodal'];

function formatTimestamp(value: string): string {
  try {
    return new Intl.DateTimeFormat('es-CO', {
      hour: '2-digit',
      minute: '2-digit',
      day: '2-digit',
      month: 'short',
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function agentLabel(agent: string): string {
  const labels: Record<string, string> = {
    editorial: 'Redacción',
    etico: 'Ética',
    dialectico: 'Contraste',
    multimodal: 'Formato',
    orchestrator: 'Orquestador',
  };
  return labels[agent] ?? agent;
}

function shortId(value?: string | null): string {
  if (!value) {
    return 'sin sesión';
  }
  return value.length > 10 ? `${value.slice(0, 8)}...` : value;
}

function summarizeText(value: string, maxLength = 92): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length > maxLength ? `${clean.slice(0, maxLength - 1)}...` : clean;
}

function getAgentResults(session: SessionResponse | null): AgentResult[] {
  if (!session) {
    return [];
  }

  return AGENT_ORDER.map((agent) => session[agent]).filter((result): result is AgentResult => Boolean(result));
}

function eventSummary(event: BusEvent): string {
  const payload = event.payload ?? {};
  if (typeof payload.output === 'string') {
    return summarizeText(payload.output);
  }
  if (typeof payload.status === 'string') {
    return `Estado: ${payload.status}`;
  }
  if (typeof payload.agent === 'string') {
    return `Agente: ${agentLabel(payload.agent)}`;
  }
  return Object.keys(payload).length ? JSON.stringify(payload, null, 2) : 'Evento recibido';
}

function buildMessages(session: SessionResponse | null): ChatMessage[] {
  if (!session?.input_text) {
    return [];
  }

  const messages: ChatMessage[] = [
    {
      id: `${session.session_id}-input`,
      role: 'user',
      title: 'Tú',
      body: session.input_text,
      meta: shortId(session.session_id),
    },
  ];

  const results = getAgentResults(session);
  if (results.length) {
    messages.push({
      id: `${session.session_id}-answer`,
      role: 'assistant',
      title: 'NOVA',
      body: results.map((result) => `## ${agentLabel(result.agent)}\n${result.output}`).join('\n\n'),
      meta: session.status,
    });
  }

  return messages;
}

function buildThinkItems(session: SessionResponse | null, events: BusEvent[]) {
  const traceItems = (session?.trace ?? []).map((step) => ({
    id: `${session?.session_id}-${step.agent}-${step.output.slice(0, 12)}`,
    title: agentLabel(step.agent),
    body: step.output,
    meta: step.warnings?.length ? step.warnings.join(' · ') : `${step.tokens_used ?? 0} tokens`,
    done: !step.error,
  }));

  const liveItems = events
    .filter((event) => event.session_id === session?.session_id || !session?.session_id)
    .slice(-8)
    .map((event) => ({
      id: event.id,
      title: event.type,
      body: eventSummary(event),
      meta: formatTimestamp(event.created_at),
      done: event.type.includes('completed'),
    }));

  return [...traceItems, ...liveItems];
}

function buildDoItems(session: SessionResponse | null) {
  return getAgentResults(session).map((result) => ({
    id: `${session?.session_id}-${result.agent}-do`,
    title: agentLabel(result.agent),
    body: result.output,
    meta: result.error ? `Error: ${result.error}` : result.questions?.length ? `${result.questions.length} preguntas` : 'Listo',
    done: !result.error,
  }));
}

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [authProviders, setAuthProviders] = useState<AuthProvidersResponse | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<SessionResponse | null>(null);
  const [events, setEvents] = useState<BusEvent[]>([]);
  const [inputText, setInputText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sideNote, setSideNote] = useState('Listo para crear una sesión.');
  const [workMode, setWorkMode] = useState<WorkMode>('think');
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const authParams = consumeAuthParams();
        if (authParams.token) {
          setAuthToken(authParams.token);
        }
        if (authParams.error) {
          setError(`Google no pudo iniciar sesión: ${authParams.error}`);
        }

        const [healthResponse, providersResponse] = await Promise.all([getHealth(), getAuthProviders()]);
        setHealth(healthResponse);
        setAuthProviders(providersResponse);

        const token = getAuthToken();
        if (providersResponse.auth_required && !token) {
          return;
        }

        if (token) {
          const me = await getCurrentUser();
          setUser(me.user);
        }

        const sessionList = await listSessions();
        setSessions(sessionList);
        if (sessionList[0]?.session_id) {
          setActiveSessionId(sessionList[0].session_id);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'No se pudo conectar con el backend');
        if (err instanceof Error && err.message.includes('401')) {
          clearAuthToken();
          setUser(null);
        }
      } finally {
        setAuthReady(true);
      }
    })();
  }, []);

  useEffect(() => {
    if (!activeSessionId) {
      setActiveSession(null);
      return;
    }

    void (async () => {
      try {
        const session = await getSession(activeSessionId);
        setActiveSession(session);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'No se pudo cargar la sesión');
      }
    })();
  }, [activeSessionId]);

  useEffect(() => {
    if (!authReady || (authProviders?.auth_required && !user)) {
      return undefined;
    }

    const socket = createSocket();

    socket.on('connect', () => {
      setSideNote(`Conectado en vivo`);
    });

    socket.on('agent_event', (payload: unknown) => {
      if (!isBusEvent(payload)) {
        return;
      }
      setEvents((current) => [...current, payload]);
      setSideNote(payload.type);
      if (payload.session_id === activeSessionId && payload.type === 'session.completed') {
        void getSession(payload.session_id).then(setActiveSession).catch(() => undefined);
      }
    });

    socket.on('actualizar_chat', (payload: { msg?: string }) => {
      setSideNote(payload?.msg ?? 'Canvas actualizado');
    });

    socket.on('connect_error', (err: Error) => {
      setSideNote(`Socket sin conexión: ${err.message}`);
    });

    return () => {
      socket.disconnect();
    };
  }, [activeSessionId, authProviders?.auth_required, authReady, user]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [activeSession, loading]);

  const messages = useMemo(() => buildMessages(activeSession), [activeSession]);
  const thinkItems = useMemo(() => buildThinkItems(activeSession, events), [activeSession, events]);
  const doItems = useMemo(() => buildDoItems(activeSession), [activeSession]);
  const visibleWorkItems = workMode === 'think' ? thinkItems : doItems;
  const activeSessionEvents = events.filter((event) => event.session_id === activeSessionId);

  async function submitPrompt() {
    const prompt = inputText.trim();
    if (!prompt || loading) {
      return;
    }

    setLoading(true);
    setError(null);
    setSideNote('NOVA está pensando...');
    try {
      const response = await createSession(prompt, activeSessionId ?? undefined);
      setActiveSession(response);
      setActiveSessionId(response.session_id);
      setInputText('');
      setSessions((current) => [
        {
          session_id: response.session_id,
          title: response.input_text || prompt,
          status: response.status,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          user_id: null,
        },
        ...current.filter((item) => item.session_id !== response.session_id),
      ]);
      setSideNote(`Sesión ${response.status}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo crear la sesión');
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitPrompt();
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submitPrompt();
    }
  }

  function startNewSession() {
    setActiveSession(null);
    setActiveSessionId(null);
    setEvents([]);
    setError(null);
    setSideNote('Nueva sesión lista.');
    setInputText('');
  }

  function handleLogout() {
    clearAuthToken();
    setUser(null);
    setSessions([]);
    startNewSession();
  }

  const loginRequired = authReady && Boolean(authProviders?.auth_required) && !user;

  if (!authReady) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <div className="brand-mark">N</div>
          <h1>NOVA</h1>
          <p>Preparando la sesión segura...</p>
          <div className="thinking-loader auth-loader">
            <span />
            <span />
            <span />
          </div>
        </div>
      </div>
    );
  }

  if (loginRequired) {
    return (
      <div className="auth-screen">
        <section className="auth-card">
          <div className="brand-mark">N</div>
          <span className="eyebrow">NOVA Studio</span>
          <h1>Inicia sesión para continuar</h1>
          <p>El backend de Railway tiene autenticación activa. Entra con Google para cargar tus sesiones y usar los agentes.</p>
          {error && <p className="error-line">{error}</p>}
          <a className="google-button" href={getGoogleLoginUrl()}>
            <span>G</span>
            Continuar con Google
          </a>
          <small>{getApiBaseUrl()}</small>
        </section>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">N</div>
          <div>
            <strong>NOVA</strong>
            <span>White-box newsroom AI</span>
          </div>
        </div>

        <button className="new-chat-button" onClick={startNewSession} type="button">
          <span>+</span>
          Nueva conversación
        </button>

        <div className="connection-chip">
          <span className={`status-dot ${health?.status === 'ok' ? 'status-dot--live' : ''}`} />
          <div>
            <strong>{health?.status === 'ok' ? 'Backend activo' : 'Backend pendiente'}</strong>
            <small>{getApiBaseUrl()}</small>
          </div>
        </div>

        {user && (
          <div className="user-chip">
            {user.avatar_url ? <img alt="" src={user.avatar_url} /> : <div className="avatar">{user.name.slice(0, 1)}</div>}
            <div>
              <strong>{user.name}</strong>
              <small>{user.email}</small>
            </div>
            <button onClick={handleLogout} type="button" title="Cerrar sesión">
              Salir
            </button>
          </div>
        )}

        <section className="sidebar-section">
          <div className="section-title">
            <span>Historial</span>
            <small>{sessions.length}</small>
          </div>
          <div className="session-list">
            {sessions.map((session) => (
              <button
                key={session.session_id}
                className={`session-item ${session.session_id === activeSessionId ? 'session-item--active' : ''}`}
                onClick={() => setActiveSessionId(session.session_id)}
                type="button"
              >
                <strong>{summarizeText(session.title, 54)}</strong>
                <span>{session.status} · {formatTimestamp(session.updated_at)}</span>
              </button>
            ))}
            {sessions.length === 0 && <p className="empty-state">Aún no hay sesiones.</p>}
          </div>
        </section>
      </aside>

      <main className="chat-shell">
        <header className="topbar">
          <div>
            <span className="eyebrow">NOVA Studio</span>
            <h1>{activeSession?.input_text ? summarizeText(activeSession.input_text, 74) : 'Nueva conversación'}</h1>
          </div>
          <div className="topbar-status">
            <span>{activeSession?.status ?? 'sin sesión'}</span>
            <small>{shortId(activeSessionId)}</small>
          </div>
        </header>

        <section className="message-stream" aria-label="Conversación">
          {messages.map((message) => (
            <article className={`message message--${message.role}`} key={message.id}>
              <div className="avatar">{message.role === 'user' ? 'Tú' : 'N'}</div>
              <div className="message-content">
                <div className="message-top">
                  <strong>{message.title}</strong>
                  {message.meta ? <span>{message.meta}</span> : null}
                </div>
                <pre>{message.body}</pre>
              </div>
            </article>
          ))}

          {loading && (
            <article className="message message--assistant">
              <div className="avatar">N</div>
              <div className="message-content">
                <div className="message-top">
                  <strong>NOVA</strong>
                  <span>{sideNote}</span>
                </div>
                <div className="thinking-loader">
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            </article>
          )}

          {messages.length === 0 && !loading && (
            <div className="welcome-state">
              <h2>Pregunta, edita o pide una pieza periodística.</h2>
              <p>NOVA mostrará la respuesta final y dejará visible cómo pensaron y qué hicieron los agentes.</p>
              <div className="prompt-grid">
                <button onClick={() => setInputText('Escribe un artículo sobre los retos de la transición energética justa en Colombia.')} type="button">
                  Artículo con enfoque local
                </button>
                <button onClick={() => setInputText('Revisa éticamente este texto y señala riesgos de sesgo, daño o falta de contexto.')} type="button">
                  Revisión ética
                </button>
                <button onClick={() => setInputText('Convierte esta nota en un hilo breve para redes y una entradilla para web.')} type="button">
                  Adaptación multimodal
                </button>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </section>

        <form className="composer" onSubmit={handleSubmit}>
          {error && <p className="error-line">{error}</p>}
          <textarea
            aria-label="Mensaje para NOVA"
            onChange={(event) => setInputText(event.target.value)}
            onKeyDown={handleComposerKeyDown}
            placeholder="Escribe tu solicitud..."
            rows={1}
            value={inputText}
          />
          <button className="send-button" disabled={loading || !inputText.trim()} title="Enviar" type="submit">
            ↑
          </button>
        </form>
      </main>

      <aside className="work-panel">
        <div className="work-header">
          <div>
            <span className="eyebrow">Trazabilidad</span>
            <h2>Pensar y hacer</h2>
          </div>
          <span className="live-pill">{activeSessionEvents.length || events.length} eventos</span>
        </div>

        <div className="segmented-control" role="tablist" aria-label="Modo de trazabilidad">
          <button className={workMode === 'think' ? 'active' : ''} onClick={() => setWorkMode('think')} type="button">
            Pensar
          </button>
          <button className={workMode === 'do' ? 'active' : ''} onClick={() => setWorkMode('do')} type="button">
            Hacer
          </button>
        </div>

        <div className="work-list">
          {visibleWorkItems.map((item) => (
            <article className="work-item" key={item.id}>
              <div className="work-item-top">
                <span className={item.done ? 'step-dot step-dot--done' : 'step-dot'} />
                <strong>{item.title}</strong>
              </div>
              <p>{item.body}</p>
              <small>{item.meta}</small>
            </article>
          ))}

          {visibleWorkItems.length === 0 && (
            <div className="empty-work">
              <strong>{workMode === 'think' ? 'Sin pensamiento aún' : 'Sin acciones aún'}</strong>
              <p>Cuando ejecutes una solicitud, aquí aparecerán los pasos del backend y los resultados de cada agente.</p>
            </div>
          )}
        </div>

        <section className="knowledge-box">
          <div className="section-title">
            <span>BCL / RAG</span>
            <small>{activeSession?.knowledge_hits?.length ?? 0}</small>
          </div>
          {(activeSession?.knowledge_hits ?? []).slice(0, 3).map((hit, index) => (
            <article key={`${hit.source}-${index}`}>
              <strong>{hit.source}</strong>
              <p>{summarizeText(hit.text, 120)}</p>
              {typeof hit.score === 'number' && <small>score {hit.score.toFixed(2)}</small>}
            </article>
          ))}
          {!activeSession?.knowledge_hits?.length && <p className="empty-state">Sin documentos recuperados todavía.</p>}
        </section>
      </aside>
    </div>
  );
}
