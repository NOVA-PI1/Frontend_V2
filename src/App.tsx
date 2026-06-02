import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  applyDriveAction,
  clearAuthToken,
  consumeAuthParams,
  createDraft,
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
  suggestQuestions,
} from './api';
import { createSocket, isBusEvent } from './socket';
import type {
  AgentResult,
  AuthProvidersResponse,
  AuthUser,
  BusEvent,
  ChatMessage,
  DraftRevision,
  HealthResponse,
  Operation,
  OutputFormat,
  SessionResponse,
  SessionSummary,
} from './types';

type WorkMode = 'think' | 'do';
type SessionAgent = 'editorial' | 'etico' | 'dialectico' | 'multimodal';
type QuickAction = 'expand' | 'revise' | 'question' | 'format';

type WorkItem = {
  id: string;
  title: string;
  body: string;
  meta: string;
  done: boolean;
  warningsCount?: number;
  questionsCount?: number;
  tokensUsed?: number;
  error?: boolean;
};

const AGENT_ORDER: SessionAgent[] = ['editorial', 'etico', 'dialectico', 'multimodal'];
const FORMAT_OPTIONS: Array<{ value: OutputFormat; label: string }> = [
  { value: 'article', label: 'Artículo' },
  { value: 'twitter_thread', label: 'Hilo X' },
  { value: 'instagram_post', label: 'Instagram' },
  { value: 'instagram_carousel', label: 'Carrusel' },
  { value: 'linkedin_post', label: 'LinkedIn' },
  { value: 'caption', label: 'Caption' },
];

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

function draftLabel(draft: DraftRevision): string {
  return `v${draft.version} · ${draft.source}`;
}

function selectedDraft(session: SessionResponse | null, selectedDraftId: number | null): DraftRevision | null {
  if (!session) {
    return null;
  }
  const drafts = session.drafts ?? [];
  return drafts.find((draft) => draft.id === selectedDraftId) ?? session.current_draft ?? drafts[drafts.length - 1] ?? null;
}

function currentTextLabel(session: SessionResponse | null, draft: DraftRevision | null): string {
  if (draft) {
    return `Borrador activo ${draftLabel(draft)}`;
  }
  if (session?.editorial?.output) {
    return 'Salida editorial';
  }
  return 'Texto original';
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
      body: results.map((result) => `${agentLabel(result.agent)}\n${result.output}`).join('\n\n'),
      meta: session.status,
      agentBlocks: results.map((result) => ({
        agent: result.agent,
        output: result.output,
        warnings: result.warnings,
        questions: result.questions,
        tokens_used: result.tokens_used,
        error: result.error,
      })),
    });
  }

  return messages;
}

function buildThinkItems(session: SessionResponse | null, events: BusEvent[]): WorkItem[] {
  const traceItems = (session?.trace ?? []).map((step) => ({
    id: `${session?.session_id}-${step.agent}-${step.output.slice(0, 12)}`,
    title: agentLabel(step.agent),
    body: step.output,
    meta: step.warnings?.length ? step.warnings.join(' · ') : `${step.tokens_used ?? 0} tokens`,
    done: !step.error,
    warningsCount: step.warnings?.length ?? 0,
    questionsCount: step.questions?.length ?? 0,
    tokensUsed: step.tokens_used ?? 0,
    error: Boolean(step.error),
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
      error: event.type.includes('error'),
    }));

  return [...traceItems, ...liveItems];
}

function buildDoItems(session: SessionResponse | null): WorkItem[] {
  return getAgentResults(session).map((result) => ({
    id: `${session?.session_id}-${result.agent}-do`,
    title: agentLabel(result.agent),
    body: result.output,
    meta: result.error ? `Error: ${result.error}` : result.questions?.length ? `${result.questions.length} preguntas` : 'Listo',
    done: !result.error,
    warningsCount: result.warnings?.length ?? 0,
    questionsCount: result.questions?.length ?? 0,
    tokensUsed: result.tokens_used ?? 0,
    error: Boolean(result.error),
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
  const [operation, setOperation] = useState<Operation>('generate');
  const [outputFormat, setOutputFormat] = useState<OutputFormat>('article');
  const [useWebContext, setUseWebContext] = useState(false);
  const [selectedDraftId, setSelectedDraftId] = useState<number | null>(null);
  const [canvasText, setCanvasText] = useState('');
  const [canvasSaving, setCanvasSaving] = useState(false);
  const [questionsLoading, setQuestionsLoading] = useState(false);
  const [driveLoading, setDriveLoading] = useState(false);
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

  useEffect(() => {
    const drafts = activeSession?.drafts ?? [];
    const draft = activeSession?.current_draft ?? drafts[drafts.length - 1] ?? null;
    setSelectedDraftId(draft?.id ?? null);
    setCanvasText(draft?.content ?? activeSession?.editorial?.output ?? activeSession?.input_text ?? '');
  }, [activeSession?.session_id, activeSession?.current_draft?.id, activeSession?.editorial?.output]);

  const messages = useMemo(() => buildMessages(activeSession), [activeSession]);
  const thinkItems = useMemo(() => buildThinkItems(activeSession, events), [activeSession, events]);
  const doItems = useMemo(() => buildDoItems(activeSession), [activeSession]);
  const agentResults = useMemo(() => getAgentResults(activeSession), [activeSession]);
  const visibleWorkItems = workMode === 'think' ? thinkItems : doItems;
  const activeSessionEvents = events.filter((event) => event.session_id === activeSessionId);
  const activeDraft = selectedDraft(activeSession, selectedDraftId);
  const activeTextDescriptor = currentTextLabel(activeSession, activeDraft);
  const completedAgents = agentResults.filter((result) => !result.error && result.output?.trim().length).length;
  const progressPercent = agentResults.length ? Math.round((completedAgents / agentResults.length) * 100) : 0;

  async function submitPrompt() {
    const prompt = inputText.trim();
    const fallbackPrompt =
      operation === 'format'
        ? `Adaptar el borrador activo a formato ${outputFormat}.`
        : operation === 'question'
          ? 'Formula preguntas críticas sobre el texto activo.'
          : operation === 'revise'
            ? 'Revisa el borrador activo manteniendo su intención.'
            : '';
    const instruction = prompt || fallbackPrompt;
    if (!instruction || loading) {
      return;
    }

    setLoading(true);
    setError(null);
    setSideNote('NOVA está pensando...');
    try {
      const response = await createSession(instruction, {
        sessionId: activeSessionId ?? undefined,
        operation,
        targetDraftId: selectedDraftId,
        outputFormat,
        useWebContext,
      });
      setActiveSession(response);
      setActiveSessionId(response.session_id);
      setInputText('');
      setSessions((current) => [
        {
          session_id: response.session_id,
          title: response.input_text || instruction,
          status: response.status,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          user_id: null,
        },
        ...current.filter((item) => item.session_id !== response.session_id),
      ]);
      if (response.current_draft?.content) {
        setCanvasText(response.current_draft.content);
        setSelectedDraftId(response.current_draft.id ?? null);
      }
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

  async function refreshActiveSession(sessionId = activeSessionId) {
    if (!sessionId) {
      return;
    }
    const session = await getSession(sessionId);
    setActiveSession(session);
  }

  async function saveCanvasDraft() {
    if (!activeSessionId || !canvasText.trim() || canvasSaving) {
      return;
    }
    setCanvasSaving(true);
    setError(null);
    try {
      const draft = await createDraft(activeSessionId, canvasText.trim(), 'Edición manual de canvas');
      setSelectedDraftId(draft.id ?? null);
      await refreshActiveSession(activeSessionId);
      setSideNote(`Canvas guardado como ${draftLabel(draft)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar el canvas');
    } finally {
      setCanvasSaving(false);
    }
  }

  async function requestQuestions(questionText?: string) {
    if (!activeSessionId || questionsLoading) {
      return;
    }
    setQuestionsLoading(true);
    setError(null);
    try {
      await suggestQuestions(activeSessionId, questionText ?? canvasText, selectedDraftId);
      await refreshActiveSession(activeSessionId);
      setSideNote('Preguntas actualizadas');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudieron generar preguntas');
    } finally {
      setQuestionsLoading(false);
    }
  }

  async function runQuestion(question: string) {
    setOperation('question');
    setInputText(question);
    await createSession(question, {
      sessionId: activeSessionId ?? undefined,
      operation: 'question',
      targetDraftId: selectedDraftId,
      outputFormat,
      useWebContext,
    })
      .then((response) => {
        setActiveSession(response);
        setActiveSessionId(response.session_id);
        setInputText('');
        setSideNote('Pregunta enviada al texto activo');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'No se pudo enviar la pregunta'));
  }

  async function runQuickAction(action: QuickAction) {
    if (!activeSessionId || loading) {
      return;
    }

    const config: Record<QuickAction, { operation: Operation; instruction: string; format?: OutputFormat; sideNote: string }> = {
      expand: {
        operation: 'revise',
        instruction: 'Amplía el borrador activo con más contexto, datos y matices sin perder precisión.',
        sideNote: 'Ampliando borrador activo...',
      },
      revise: {
        operation: 'revise',
        instruction: 'Ajusta el borrador activo para mejorar claridad, ritmo y enfoque editorial.',
        sideNote: 'Ajustando borrador activo...',
      },
      question: {
        operation: 'question',
        instruction: 'Genera preguntas críticas y de seguimiento sobre el borrador activo.',
        sideNote: 'Generando preguntas críticas...',
      },
      format: {
        operation: 'format',
        instruction: 'Adapta el borrador activo a un carrusel de Instagram con enfoque periodístico.',
        format: 'instagram_carousel',
        sideNote: 'Formateando salida social...',
      },
    };

    const next = config[action];
    setLoading(true);
    setError(null);
    setSideNote(next.sideNote);
    setOperation(next.operation);
    if (next.format) {
      setOutputFormat(next.format);
    }

    try {
      const response = await createSession(next.instruction, {
        sessionId: activeSessionId,
        operation: next.operation,
        targetDraftId: selectedDraftId,
        outputFormat: next.format ?? outputFormat,
        useWebContext,
      });
      setActiveSession(response);
      setActiveSessionId(response.session_id);
      setSideNote(`Acción completada: ${next.operation}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo ejecutar la acción rápida');
    } finally {
      setLoading(false);
    }
  }

  async function syncDrive(action: 'create' | 'update' | 'delete') {
    if (!activeSessionId || driveLoading) {
      return;
    }
    setDriveLoading(true);
    setError(null);
    try {
      await applyDriveAction(activeSessionId, action, selectedDraftId, canvasText);
      await refreshActiveSession(activeSessionId);
      setSideNote(action === 'delete' ? 'Documento de Drive eliminado' : 'Drive sincronizado');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo sincronizar Drive');
    } finally {
      setDriveLoading(false);
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
            <span>Sala de redacción asistida</span>
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
            <p className="topbar-lead">
              {activeSessionId
                ? 'Edita, pregunta y reformatea desde el mismo flujo editorial.'
                : 'Inicia una investigación y observa en vivo cómo piensa cada agente.'}
            </p>
            <small className="active-text-label">{activeTextDescriptor}</small>
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
                {message.role === 'assistant' && message.agentBlocks?.length ? (
                  <div className="agent-output-list">
                    {message.agentBlocks.map((block) => (
                      <article
                        className={`agent-output-card ${block.agent === 'editorial' ? 'agent-output-card--primary' : ''}`}
                        key={`${message.id}-${block.agent}`}
                      >
                        <header>
                          <strong>{agentLabel(block.agent)}</strong>
                          <div className="agent-output-badges">
                            <span>{block.tokens_used ?? 0} tk</span>
                            {block.warnings?.length ? <span>{block.warnings.length} alertas</span> : null}
                            {block.questions?.length ? <span>{block.questions.length} preguntas</span> : null}
                            {block.error ? <span className="badge-error">error</span> : null}
                          </div>
                        </header>
                        <pre>{block.output}</pre>
                      </article>
                    ))}
                    <div className="agent-action-row">
                      <button disabled={!activeSessionId || loading} onClick={() => void runQuickAction('expand')} type="button">
                        Ampliar
                      </button>
                      <button disabled={!activeSessionId || loading} onClick={() => void runQuickAction('revise')} type="button">
                        Ajustar
                      </button>
                      <button disabled={!activeSessionId || loading} onClick={() => void runQuickAction('question')} type="button">
                        Preguntas
                      </button>
                      <button disabled={!activeSessionId || loading} onClick={() => void runQuickAction('format')} type="button">
                        Carrusel
                      </button>
                    </div>
                  </div>
                ) : (
                  <pre>{message.body}</pre>
                )}
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
              <h2>Haz una pregunta y construye una pieza lista para publicar.</h2>
              <p>NOVA entrega resultado final, trazabilidad por agente y acciones rápidas para iterar sin salir del editor.</p>
              <div className="welcome-kpis" aria-label="Indicadores de flujo editorial">
                <span>Pensar visible</span>
                <span>Hacer accionable</span>
                <span>Output reutilizable</span>
              </div>
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
          <div className="composer-controls" aria-label="Controles editoriales">
            <select
              aria-label="Operación"
              onChange={(event) => setOperation(event.target.value as Operation)}
              value={operation}
            >
              <option value="generate">Generar</option>
              <option value="revise">Revisar canvas</option>
              <option value="question">Preguntar</option>
              <option value="format">Formatear</option>
            </select>
            <select
              aria-label="Formato de salida"
              disabled={operation !== 'format'}
              onChange={(event) => setOutputFormat(event.target.value as OutputFormat)}
              value={outputFormat}
            >
              {FORMAT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <label className="toggle-control">
              <input checked={useWebContext} onChange={(event) => setUseWebContext(event.target.checked)} type="checkbox" />
              Web
            </label>
          </div>
          <textarea
            aria-label="Mensaje para NOVA"
            onChange={(event) => setInputText(event.target.value)}
            onKeyDown={handleComposerKeyDown}
            placeholder={
              operation === 'revise'
                ? 'Indica cómo modificar el borrador activo...'
                : operation === 'question'
                  ? 'Pregunta algo sobre el texto activo...'
                  : operation === 'format'
                    ? 'Añade una instrucción opcional para el formato...'
                    : 'Escribe tu solicitud...'
            }
            rows={1}
            value={inputText}
          />
          <button
            className="send-button"
            disabled={loading || (!inputText.trim() && operation === 'generate')}
            title="Enviar"
            type="submit"
          >
            ↑
          </button>
        </form>
      </main>

      <aside className="work-panel">
        <section className="canvas-box">
          <div className="section-title">
            <span>Canvas editorial</span>
            <small>{activeTextDescriptor}</small>
          </div>

          {!activeSessionId && (
            <div className="canvas-empty">
              <strong>Canvas listo para producir</strong>
              <p>Envía una primera instrucción para crear borrador, luego ajusta versión por versión desde este panel.</p>
            </div>
          )}

          <textarea
            aria-label="Borrador activo"
            disabled={!activeSessionId}
            onChange={(event) => setCanvasText(event.target.value)}
            placeholder="El borrador activo aparecerá aquí."
            value={canvasText}
          />

          <div className="canvas-actions">
            <select
              aria-label="Historial de versiones"
              disabled={!activeSession?.drafts?.length}
              onChange={(event) => {
                const nextId = event.target.value ? Number(event.target.value) : null;
                const nextDraft = (activeSession?.drafts ?? []).find((draft) => draft.id === nextId) ?? null;
                setSelectedDraftId(nextId);
                setCanvasText(nextDraft?.content ?? activeSession?.editorial?.output ?? '');
              }}
              value={selectedDraftId ?? ''}
            >
              <option value="">Sin versión</option>
              {(activeSession?.drafts ?? []).map((draft) => (
                <option key={draft.id ?? draft.version} value={draft.id ?? ''}>
                  {draftLabel(draft)}
                </option>
              ))}
            </select>
            <button disabled={!activeSessionId || canvasSaving || !canvasText.trim()} onClick={saveCanvasDraft} type="button">
              {canvasSaving ? 'Guardando...' : 'Guardar'}
            </button>
          </div>

          <div className="question-list">
            <div className="section-title">
              <span>Preguntas sugeridas</span>
              <button disabled={!activeSessionId || questionsLoading} onClick={() => void requestQuestions()} type="button">
                {questionsLoading ? '...' : 'Generar'}
              </button>
            </div>
            {(activeSession?.suggested_questions ?? []).slice(0, 6).map((question) => (
              <button key={question} onClick={() => void runQuestion(question)} type="button">
                {question}
              </button>
            ))}
            {!activeSession?.suggested_questions?.length && <p className="empty-state">Sin preguntas todavía.</p>}
          </div>

          <div className="drive-box">
            <div>
              <strong>{activeSession?.drive_document ? 'Google Doc vinculado' : 'Sin Google Doc'}</strong>
              {activeSession?.drive_document && <small>{formatTimestamp(activeSession.drive_document.last_synced_at)}</small>}
            </div>
            <div className="drive-actions">
              <button disabled={!activeSessionId || driveLoading} onClick={() => void syncDrive(activeSession?.drive_document ? 'update' : 'create')} type="button">
                {activeSession?.drive_document ? 'Actualizar' : 'Crear'}
              </button>
              {activeSession?.drive_document && (
                <a href={activeSession.drive_document.url} rel="noreferrer" target="_blank">
                  Abrir
                </a>
              )}
              <button disabled={!activeSession?.drive_document || driveLoading} onClick={() => void syncDrive('delete')} type="button">
                Borrar
              </button>
            </div>
          </div>
        </section>

        <div className="work-header">
          <div>
            <span className="eyebrow">Trazabilidad</span>
            <h2>Pensar y hacer</h2>
            <div className="progress-line" aria-label="Progreso de agentes">
              <span style={{ width: `${progressPercent}%` }} />
            </div>
          </div>
          <span className="live-pill">{completedAgents}/{agentResults.length || 0} agentes</span>
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
            <article className={`work-item ${item.error ? 'work-item--error' : ''}`} key={item.id}>
              <div className="work-item-top">
                <span className={item.done ? 'step-dot step-dot--done' : 'step-dot'} />
                <strong>{item.title}</strong>
                <div className="work-badges">
                  {typeof item.tokensUsed === 'number' ? <span>{item.tokensUsed} tk</span> : null}
                  {item.warningsCount ? <span>{item.warningsCount} alertas</span> : null}
                  {item.questionsCount ? <span>{item.questionsCount} preguntas</span> : null}
                </div>
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

        <section className="knowledge-box">
          <div className="section-title">
            <span>Web / citas</span>
            <small>{activeSession?.web_hits?.length ?? 0}</small>
          </div>
          {(activeSession?.web_hits ?? []).slice(0, 4).map((hit) => (
            <article key={hit.url}>
              <strong>{hit.title}</strong>
              <p>{summarizeText(hit.snippet || hit.url, 130)}</p>
              <a href={hit.url} rel="noreferrer" target="_blank">
                Abrir fuente
              </a>
              {hit.published_at && <small>{hit.published_at}</small>}
            </article>
          ))}
          {!activeSession?.web_hits?.length && <p className="empty-state">Activa Web antes de enviar para traer contexto externo.</p>}
        </section>

        {activeSession?.social_outputs && Object.keys(activeSession.social_outputs).length > 0 && (
          <section className="knowledge-box">
            <div className="section-title">
              <span>Formatos sociales</span>
              <small>{Object.keys(activeSession.social_outputs).length}</small>
            </div>
            {Object.entries(activeSession.social_outputs).map(([format, output]) => (
              <article key={format}>
                <strong>{FORMAT_OPTIONS.find((option) => option.value === format)?.label ?? format}</strong>
                <p>{summarizeText(output, 180)}</p>
              </article>
            ))}
          </section>
        )}
      </aside>
    </div>
  );
}
