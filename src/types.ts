export type HealthResponse = {
  status: string;
  environment: string;
  llm_provider: string;
  llm_model: string;
};

export type AuthProvidersResponse = {
  auth_required: boolean;
  providers: string[];
};

export type AuthUser = {
  user_id: string;
  provider: string;
  provider_user_id?: string;
  email: string;
  name: string;
  avatar_url?: string;
  email_verified?: boolean;
};

export type AuthMeResponse = {
  authenticated: boolean;
  user: AuthUser;
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
export type Operation = 'generate' | 'revise' | 'question' | 'format';
export type OutputFormat = 'article' | 'twitter_thread' | 'instagram_post' | 'instagram_carousel' | 'linkedin_post' | 'caption';

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

export type WebSearchResult = {
  title: string;
  url: string;
  snippet?: string;
  published_at?: string | null;
  source?: string;
};

export type DraftRevision = {
  id?: number | null;
  session_id: string;
  version: number;
  content: string;
  source: string;
  instruction?: string | null;
  agent?: AgentName | null;
  created_at: string;
  metadata?: Record<string, unknown>;
};

export type DriveDocument = {
  document_id: string;
  url: string;
  last_synced_at: string;
  shared: boolean;
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
  web_hits?: WebSearchResult[];
  trace?: AgentResult[];
  metadata?: Record<string, unknown>;
  drafts?: DraftRevision[];
  current_draft?: DraftRevision | null;
  suggested_questions?: string[];
  social_outputs?: Record<string, string>;
  drive_document?: DriveDocument | null;
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
