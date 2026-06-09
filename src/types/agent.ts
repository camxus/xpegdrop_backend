import { S3Location } from './index';

export type AgentType =
  | 'document-processor'
  | 'visual-qa'
  | 'data-extractor'
  | 'image-analyzer'
  | 'content-classifier'
  | 'metadata-enricher'
  | 'generic';

export type SessionStatus = 'active' | 'processing' | 'completed' | 'failed' | 'expired';
export type InteractionStatus = 'pending' | 'processing' | 'success' | 'error';

export interface CapabilityInfo {
  name: string;
  description: string;
  parameters?: Record<string, any>;
}

export interface VisionAnalysisResult {
  objects: string[];
  text?: string;
  scene: string;
  dominantColors: string[];
  confidence: number;
  suggestedAgentType: AgentType;
  inferredContext: {
    useCase: string;
    domain: string;
    dataTypes: string[];
  };
}

export interface AgentContextData {
  image_id: string;
  vision_analysis: VisionAnalysisResult;
  agent_type: AgentType;
  custom_instructions?: string;
  tools: string[];
  constraints: {
    max_tokens: number;
    timeout: number;
    rate_limit: number;
  };
  image_s3_location?: S3Location;
}

export interface AgentSessionItem {
  session_id: string;
  user_id: string;
  image_id: string;
  agent_type: AgentType;
  status: SessionStatus;
  context_data: AgentContextData;
  capabilities: CapabilityInfo[];
  created_at: number;
  expires_at: number;
}

export interface AgentInteractionItem {
  interaction_id: string;
  session_id: string;
  query: string;
  capability_name: string;
  parameters?: Record<string, any>;
  response: string;
  response_data?: Record<string, any>;
  status: InteractionStatus;
  execution_time_ms: number;
  tokens_used?: number;
  created_at: number;
  completed_at?: number;
}
