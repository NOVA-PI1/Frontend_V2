import type { HealthResponse, SessionResponse, SessionSummary } from './types';

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000';

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `HTTP ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export function getApiBaseUrl() {
  return apiBaseUrl;
}

export async function getHealth(): Promise<HealthResponse> {
  return requestJson<HealthResponse>('/health');
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

export async function createSession(inputText: string, sessionId?: string): Promise<SessionResponse> {
  return requestJson<SessionResponse>('/session', {
    method: 'POST',
    body: JSON.stringify({
      texto: inputText,
      ...(sessionId ? { session_id: sessionId } : {}),
      perfil: {},
      metadata: {},
      images: [],
    }),
  });
}
