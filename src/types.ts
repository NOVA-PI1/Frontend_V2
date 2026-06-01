export type HealthResponse = {
  status: string;
  environment: string;
  llm_provider: string;
  llm_model: string;
};

export type SessionSummary = {
  session_id: string;
  title: string;
  status: string;
  created_at: string;
  updated_at: string;
  user_id?: string | null;
};

export type AgentName = 'editorial' | 'etico' | 'dialectico' | 'multimodal' | 'orchestrator';

export type AgentResult = {
  agent: AgentName;
  output: string;
  warnings?: string[];
  questions?: string[];
  artifacts?: Array<Record<string, unknown>>;
  tokens_used?: number;
  metadata?: Record<string, unknown>;
  error?: string | null;
};

export type KnowledgeHit = {
  text: string;
  score?: number | null;
  source?: string;
};

export type SessionResponse = {
  session_id: string;
  input_text?: string;
  status: string;
  editorial?: AgentResult | null;
  etico?: AgentResult | null;
  dialectico?: AgentResult | null;
  multimodal?: AgentResult | null;
  knowledge_hits?: KnowledgeHit[];
  trace?: AgentResult[];
  metadata?: Record<string, unknown>;
};

export type BusEvent = {
  id: string;
  session_id: string;
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
};

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'event';
  title: string;
  body: string;
  meta?: string;
};
