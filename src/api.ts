import type {
  AuthMeResponse,
  AuthProvidersResponse,
  DraftRevision,
  DriveDocument,
  HealthResponse,
  Operation,
  OutputFormat,
  SessionResponse,
  SessionSummary,
} from './types';

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? 'https://novabackend-production-663e.up.railway.app';
const authTokenKey = 'nova_auth_token';

function getStoredAuthToken(): string | null {
  return window.localStorage.getItem(authTokenKey);
}

function authHeaders(): Record<string, string> {
  const token = getStoredAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`HTTP ${response.status}: ${detail || response.statusText}`);
  }

  return response.json() as Promise<T>;
}

export function getApiBaseUrl() {
  return apiBaseUrl;
}

export function getAuthToken(): string | null {
  return getStoredAuthToken();
}

export function setAuthToken(token: string): void {
  window.localStorage.setItem(authTokenKey, token);
}

export function clearAuthToken(): void {
  window.localStorage.removeItem(authTokenKey);
}

export function consumeAuthParams(): { token: string | null; error: string | null } {
  const url = new URL(window.location.href);
  const token = url.searchParams.get('auth_token');
  const error = url.searchParams.get('auth_error');
  if (token || error) {
    url.searchParams.delete('auth_token');
    url.searchParams.delete('auth_error');
    window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`);
  }
  return { token, error };
}

export function getGoogleLoginUrl(): string {
  const redirectUrl = `${window.location.origin}${window.location.pathname}`;
  const params = new URLSearchParams({ frontend_redirect_url: redirectUrl });
  return `${apiBaseUrl}/auth/google/authorize?${params.toString()}`;
}

export async function getHealth(): Promise<HealthResponse> {
  return requestJson<HealthResponse>('/health');
}

export async function getAuthProviders(): Promise<AuthProvidersResponse> {
  return requestJson<AuthProvidersResponse>('/auth/providers');
}

export async function getCurrentUser(): Promise<AuthMeResponse> {
  return requestJson<AuthMeResponse>('/auth/me');
}

export async function listSessions(userId?: string): Promise<SessionSummary[]> {
  const params = new URLSearchParams();
  if (userId) {
    params.set('user_id', userId);
  }
  return requestJson<SessionSummary[]>(`/sessions${params.toString() ? `?${params.toString()}` : ''}`);
}

export async function getSession(sessionId: string): Promise<SessionResponse> {
  return requestJson<SessionResponse>(`/session/${sessionId}`);
}

export async function deleteSession(sessionId: string): Promise<{ deleted: true }> {
  return requestJson<{ deleted: true }>(`/session/${sessionId}`, {
    method: 'DELETE',
  });
}

export type SessionOptions = {
  sessionId?: string;
  operation?: Operation;
  targetDraftId?: number | null;
  outputFormat?: OutputFormat;
  useWebContext?: boolean;
};

export async function createSession(inputText: string, options: SessionOptions = {}): Promise<SessionResponse> {
  return requestJson<SessionResponse>('/session', {
    method: 'POST',
    body: JSON.stringify({
      texto: inputText,
      ...(options.sessionId ? { session_id: options.sessionId } : {}),
      perfil: {},
      metadata: {},
      images: [],
      operation: options.operation ?? 'generate',
      target_draft_id: options.targetDraftId ?? null,
      output_format: options.outputFormat ?? 'article',
      use_web_context: Boolean(options.useWebContext),
    }),
  });
}

export async function listDrafts(sessionId: string): Promise<DraftRevision[]> {
  return requestJson<DraftRevision[]>(`/session/${sessionId}/drafts`);
}

export async function createDraft(
  sessionId: string,
  content: string,
  instruction?: string,
): Promise<DraftRevision> {
  return requestJson<DraftRevision>(`/session/${sessionId}/drafts`, {
    method: 'POST',
    body: JSON.stringify({
      content,
      source: 'canvas',
      instruction,
      agent: 'editorial',
      metadata: {},
    }),
  });
}

export async function suggestQuestions(sessionId: string, text?: string, draftId?: number | null): Promise<string[]> {
  return requestJson<string[]>(`/session/${sessionId}/questions`, {
    method: 'POST',
    body: JSON.stringify({
      text: text || null,
      draft_id: draftId ?? null,
      count: 6,
    }),
  });
}

export async function applyDriveAction(
  sessionId: string,
  action: 'create' | 'update' | 'delete',
  draftId?: number | null,
  content?: string,
): Promise<{ drive_document: DriveDocument | null }> {
  return requestJson<{ drive_document: DriveDocument | null }>(`/session/${sessionId}/drive`, {
    method: 'POST',
    body: JSON.stringify({
      action,
      draft_id: draftId ?? null,
      content: content || null,
    }),
  });
}

export async function uploadAttachments(sessionId: string, files: FileList | File[]): Promise<any> {
  const form = new FormData();
  if (files instanceof FileList) {
    for (let i = 0; i < files.length; i++) {
      form.append('files', files[i]);
    }
  } else {
    for (const f of files) {
      form.append('files', f);
    }
  }

  const token = getStoredAuthToken();
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  const response = await fetch(`${apiBaseUrl}/session/${sessionId}/attachments`, {
    method: 'POST',
    body: form,
    headers,
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`HTTP ${response.status}: ${detail || response.statusText}`);
  }

  return response.json();
}
