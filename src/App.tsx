import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  applyDriveAction,
  uploadAttachments,
  deleteSession,
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

function countWords(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function MarkdownMessage({ children }: { children: string }) {
  return (
    <div className="markdown-message">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
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
  const [uploadingFiles, setUploadingFiles] = useState(false);
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
  const primaryOutput = activeSession?.current_draft?.content ?? activeSession?.editorial?.output ?? '';
  const supportingAgents = agentResults.filter((result) => result.agent !== 'editorial');

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

  async function removeSession(sessionId: string) {
    const session = sessions.find((item) => item.session_id === sessionId);
    const confirmed = window.confirm(`Eliminar la investigación \"${session?.title ?? sessionId}\"?`);
    if (!confirmed) {
      return;
    }

    setError(null);
    try {
      await deleteSession(sessionId);
      setSessions((current) => current.filter((item) => item.session_id !== sessionId));
      setEvents((current) => current.filter((event) => event.session_id !== sessionId));

      if (activeSessionId === sessionId) {
        startNewSession();
      }
      setSideNote('Investigación eliminada.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo eliminar la investigación');
    }
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

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const files = event.target.files;
    if (!files || !activeSessionId) return;
    setUploadingFiles(true);
    setError(null);
    try {
      await uploadAttachments(activeSessionId, files);
      await refreshActiveSession(activeSessionId);
      setSideNote('Archivos subidos e indexados');
      // limpiar input
      (event.target as HTMLInputElement).value = '';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo subir el archivo');
    } finally {
      setUploadingFiles(false);
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
              <div
                key={session.session_id}
                className={`session-item session-item--group ${session.session_id === activeSessionId ? 'session-item--active' : ''}`}
              >
                <button
                  className="session-item__main"
                  onClick={() => setActiveSessionId(session.session_id)}
                  type="button"
                >
                  <strong>{summarizeText(session.title, 54)}</strong>
                  <span>{session.status} · {formatTimestamp(session.updated_at)}</span>
                </button>
                <button
                  className="session-item__delete"
                  onClick={() => void removeSession(session.session_id)}
                  type="button"
                  title="Eliminar investigación"
                >
                  Eliminar
                </button>
              </div>
            ))}
            {sessions.length === 0 && <p className="empty-state">Aún no hay sesiones.</p>}
          </div>
        </section>
      </aside>

      <main className="chat-shell">
        <header className="topbar">
          <div>
            <span className="eyebrow">NOVA Reportera</span>
            <h1>{activeSession?.input_text ? summarizeText(activeSession.input_text, 82) : 'Nueva conversación'}</h1>
            <p className="topbar-lead">
              {activeSessionId
                ? 'Trabaja la historia en conversación: respuesta, canvas y trazabilidad viven en el mismo flujo.'
                : 'Cuéntame el tema, el ángulo o la pregunta para iniciar la Caja Blanca editorial.'}
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
                    <section className="answer-card">
                      <div className="answer-card__top">
                        <div>
                          <span className="eyebrow">Respuesta principal</span>
                          <strong>{activeSession?.metadata?.display_status ? String(activeSession.metadata.display_status) : 'Borrador editorial'}</strong>
                        </div>
                        <div className="agent-output-badges">
                          <span>{countWords(primaryOutput)} palabras</span>
                          <span>{completedAgents}/{agentResults.length || 0} agentes</span>
                        </div>
                      </div>
                      <MarkdownMessage>{primaryOutput || message.body}</MarkdownMessage>
                    </section>

                    <div className="agent-action-row" aria-label="Acciones rápidas">
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
                      <button disabled={!activeSessionId || canvasSaving || !canvasText.trim()} onClick={saveCanvasDraft} type="button">
                        {canvasSaving ? 'Guardando...' : 'Guardar versión'}
                      </button>
                      <button disabled={!activeSessionId || driveLoading} onClick={() => void syncDrive(activeSession?.drive_document ? 'update' : 'create')} type="button">
                        {activeSession?.drive_document ? 'Actualizar Drive' : 'Crear Drive'}
                      </button>
                    </div>

                    <div className="inline-panels">
                      <details className="inline-panel" open>
                        <summary>
                          <span>Canvas editorial</span>
                          <small>{activeTextDescriptor}</small>
                        </summary>
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
                          <div className="drive-actions">
                            {activeSession?.drive_document && (
                              <a href={activeSession.drive_document.url} rel="noreferrer" target="_blank">
                                Abrir Doc
                              </a>
                            )}
                            <button disabled={!activeSession?.drive_document || driveLoading} onClick={() => void syncDrive('delete')} type="button">
                              Borrar Drive
                            </button>
                          </div>
                        </div>
                      </details>

                      <details className="inline-panel">
                        <summary>
                          <span>Trazabilidad</span>
                          <small>{completedAgents}/{agentResults.length || 0} agentes</small>
                        </summary>
                        <div className="progress-line" aria-label="Progreso de agentes">
                          <span style={{ width: `${progressPercent}%` }} />
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
                              <p>{summarizeText(item.body, 260)}</p>
                              <small>{item.meta}</small>
                            </article>
                          ))}
                          {visibleWorkItems.length === 0 && <p className="empty-state">Sin trazabilidad todavía.</p>}
                        </div>
                        {activeSessionEvents.length > 0 && (
                          <div className="event-strip">
                            {activeSessionEvents.slice(-4).map((event) => (
                              <span key={event.id}>{event.type}</span>
                            ))}
                          </div>
                        )}
                      </details>

                      {supportingAgents.map((block) => (
                        <details className="inline-panel" key={`${message.id}-${block.agent}`}>
                          <summary>
                            <span>{agentLabel(block.agent)}</span>
                            <small>{block.tokens_used ?? 0} tk</small>
                          </summary>
                          <div className="agent-output-badges">
                            {block.warnings?.length ? <span>{block.warnings.length} alertas</span> : null}
                            {block.questions?.length ? <span>{block.questions.length} preguntas</span> : null}
                            {block.error ? <span className="badge-error">error</span> : null}
                          </div>
                          <MarkdownMessage>{block.output}</MarkdownMessage>
                        </details>
                      ))}

                      <details className="inline-panel">
                        <summary>
                          <span>Preguntas sugeridas</span>
                          <small>{activeSession?.suggested_questions?.length ?? 0}</small>
                        </summary>
                        <div className="question-list">
                          <button disabled={!activeSessionId || questionsLoading} onClick={() => void requestQuestions()} type="button">
                            {questionsLoading ? 'Generando...' : 'Generar preguntas'}
                          </button>
                          {(activeSession?.suggested_questions ?? []).slice(0, 6).map((question) => (
                            <button key={question} onClick={() => void runQuestion(question)} type="button">
                              {question}
                            </button>
                          ))}
                          {!activeSession?.suggested_questions?.length && <p className="empty-state">Sin preguntas todavía.</p>}
                        </div>
                      </details>

                      <details className="inline-panel">
                        <summary>
                          <span>Contexto y formatos</span>
                          <small>{(activeSession?.knowledge_hits?.length ?? 0) + (activeSession?.web_hits?.length ?? 0)}</small>
                        </summary>
                        <div className="context-grid">
                          <section className="knowledge-box">
                            <div className="section-title">
                              <span>BCL / RAG</span>
                              <small>{activeSession?.knowledge_hits?.length ?? 0}</small>
                            </div>
                            {(activeSession?.knowledge_hits ?? []).slice(0, 3).map((hit, index) => (
                              <article key={`${hit.source}-${index}`}>
                                <strong>{hit.source}</strong>
                                <p>{summarizeText(hit.text, 130)}</p>
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
                                <p>{summarizeText(hit.snippet || hit.url, 140)}</p>
                                <a href={hit.url} rel="noreferrer" target="_blank">
                                  Abrir fuente
                                </a>
                                {hit.published_at && <small>{hit.published_at}</small>}
                              </article>
                            ))}
                            {!activeSession?.web_hits?.length && <p className="empty-state">Activa Web antes de enviar para traer contexto externo.</p>}
                          </section>
                        </div>

                        {activeSession?.social_outputs && Object.keys(activeSession.social_outputs).length > 0 && (
                          <section className="social-box">
                            <div className="section-title">
                              <span>Formatos sociales</span>
                              <small>{Object.keys(activeSession.social_outputs).length}</small>
                            </div>
                            {Object.entries(activeSession.social_outputs).map(([format, output]) => (
                              <article key={format}>
                                <strong>{FORMAT_OPTIONS.find((option) => option.value === format)?.label ?? format}</strong>
                                <MarkdownMessage>{output}</MarkdownMessage>
                              </article>
                            ))}
                          </section>
                        )}
                      </details>
                    </div>
                  </div>
                ) : (
                  <MarkdownMessage>{message.body}</MarkdownMessage>
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
              <span className="eyebrow">Caja Blanca</span>
              <h2>Haz una pregunta y construye una pieza lista para publicar.</h2>
              <p>NOVA entrega respuesta principal, trazabilidad por agente y un canvas editable sin salir del chat.</p>
              <div className="welcome-kpis" aria-label="Indicadores de flujo editorial">
                <span>Pensar visible</span>
                <span>Hacer accionable</span>
                <span>Markdown listo</span>
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
            <select aria-label="Operación" onChange={(event) => setOperation(event.target.value as Operation)} value={operation}>
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
            <label className="file-control">
              <input disabled={!activeSessionId || uploadingFiles} onChange={handleFileChange} type="file" multiple />
              <small>{uploadingFiles ? 'Subiendo...' : 'Adjuntar'}</small>
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
          <button className="send-button" disabled={loading || (!inputText.trim() && operation === 'generate')} title="Enviar" type="submit">
            ↑
          </button>
        </form>
      </main>
    </div>
  );
}
