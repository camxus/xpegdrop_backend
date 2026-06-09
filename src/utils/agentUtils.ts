import { randomUUID } from 'crypto';
import {
  AgentType,
  AgentSessionItem,
  AgentInteractionItem,
  CapabilityInfo,
  SessionStatus,
} from '../types/agent';

export function buildCapabilities(agentType: AgentType): CapabilityInfo[] {
  const capabilities: Record<AgentType, CapabilityInfo[]> = {
    'document-processor': [
      { name: 'extract_text', description: 'Extract text from document' },
      { name: 'detect_tables', description: 'Detect and parse tables' },
      { name: 'parse_forms', description: 'Parse form fields' },
      { name: 'identify_sections', description: 'Identify document sections' },
    ],
    'visual-qa': [
      { name: 'detect_objects', description: 'Locate objects in image' },
      { name: 'scene_understanding', description: 'Describe scene and context' },
      { name: 'read_visible_text', description: 'Extract visible text' },
    ],
    'data-extractor': [
      { name: 'extract_structured_data', description: 'Extract data as JSON/CSV' },
      { name: 'recognize_entities', description: 'Identify named entities' },
      { name: 'extract_relationships', description: 'Find connections between entities' },
    ],
    'image-analyzer': [
      { name: 'analyze_colors', description: 'Get color palette and histogram' },
      { name: 'analyze_composition', description: 'Rule of thirds, balance analysis' },
      { name: 'extract_metadata', description: 'EXIF and technical details' },
      { name: 'generate_image', description: 'Generate image from prompt' },
      { name: 'extend_image', description: 'Extend existing image' },
      { name: 'generate_video', description: 'Generate video from prompt' },
      { name: 'extend_video', description: 'Extend existing video' },
    ],
    'content-classifier': [
      { name: 'classify_content', description: 'Category predictions' },
      { name: 'detect_sensitivity', description: 'Content warnings and flags' },
      { name: 'auto_tag', description: 'Auto-generated tags' },
    ],
    'metadata-enricher': [
      { name: 'generate_caption', description: 'AI-generated captions' },
      { name: 'suggest_keywords', description: 'SEO and descriptive keywords' },
      { name: 'generate_description', description: 'Detailed descriptions' },
    ],
    generic: [
      { name: 'summarize', description: 'Summarize content' },
      { name: 'extract_info', description: 'Extract key information' },
    ],
  };

  return capabilities[agentType] ?? capabilities['generic'];
}

export function createSession(
  userId: string,
  imageId: string,
  agentType: AgentType,
  visionAnalysis: AgentSessionItem['context_data']['vision_analysis'],
  customInstructions?: string
): AgentSessionItem {
  const now = Date.now();
  return {
    session_id: randomUUID(),
    user_id: userId,
    image_id: imageId,
    agent_type: agentType,
    status: 'active',
    context_data: {
      image_id: imageId,
      vision_analysis: visionAnalysis,
      agent_type: agentType,
      custom_instructions: customInstructions,
      tools: [],
      constraints: { max_tokens: 4096, timeout: 30, rate_limit: 10 },
    },
    capabilities: buildCapabilities(agentType),
    created_at: now,
    expires_at: now + 24 * 60 * 60 * 1000,
  };
}

export function createInteraction(
  sessionId: string,
  query: string,
  capabilityName: string,
  response: string,
  status: SessionStatus,
  responseData?: Record<string, any>,
): AgentInteractionItem {
  const now = Date.now();
  return {
    interaction_id: randomUUID(),
    session_id: sessionId,
    query,
    capability_name: capabilityName,
    response,
    response_data: responseData,
    status: status === 'active' ? 'success' : 'error',
    execution_time_ms: 0,
    created_at: now,
    completed_at: now,
  };
}

type ExecutionResult = {
  responseText: string;
  responseData: Record<string, any>;
};

export function resolveCapabilityExecution({
  capabilityName,
  agentType,
  query,
  parameters,
  imageId,
  imageS3,
}: {
  capabilityName: string;
  agentType: AgentType;
  query: string;
  parameters?: Record<string, any>;
  imageId?: string;
  imageS3?: { bucket?: string; key?: string; url?: string };
}): ExecutionResult {
  const capability = capabilityName ? String(capabilityName).toLowerCase().replace(/\s+/g, '_') : 'unknown';
  const state = {
    agentType,
    query,
    imageId,
    imageS3,
    parameters,
    executedAt: Date.now(),
  };

  const operations: Record<string, ExecutionResult> = {
    extract_text: {
      responseText: 'Extracted text from image media.',
      responseData: { ...state, results: ['Extracted text from document area.'], confidence: 0.91 },
    },
    detect_tables: {
      responseText: 'Detected tables in the image.',
      responseData: { ...state, tableCount: 2, confidence: 0.88 },
    },
    parse_forms: {
      responseText: 'Parsed form fields from image.',
      responseData: { ...state, fields: [{ name: 'field_1', value: 'sample' }] },
    },
    identify_sections: {
      responseText: 'Identified sections in document image.',
      responseData: { ...state, sections: ['header', 'body'] },
    },
    detect_objects: {
      responseText: 'Detected objects in visual media.',
      responseData: { ...state, objects: ['text', 'table', 'chart'] },
    },
    scene_understanding: {
      responseText: 'Analyzed scene context from image.',
      responseData: { ...state, scene: 'document', confidence: 0.93 },
    },
    read_visible_text: {
      responseText: 'Read visible text from image.',
      responseData: { ...state, text: 'Extracted text from image.' },
    },
    extract_structured_data: {
      responseText: 'Extracted structured data from media.',
      responseData: { ...state, data: [{ key: 'value' }], format: 'json' },
    },
    recognize_entities: {
      responseText: 'Recognized entities from media content.',
      responseData: { ...state, entities: ['entity_1', 'entity_2'] },
    },
    extract_relationships: {
      responseText: 'Extracted entity relationships.',
      responseData: { ...state, relationships: [{ from: 'a', to: 'b' }] },
    },
    analyze_colors: {
      responseText: 'Analyzed color palette.',
      responseData: { ...state, palette: ['#ffffff', '#000000'], histogram: {} },
    },
    analyze_composition: {
      responseText: 'Analyzed media composition.',
      responseData: { ...state, composition: 'balanced', ruleOfThirds: true },
    },
    extract_metadata: {
      responseText: 'Extracted technical metadata.',
      responseData: { ...state, format: agentType, meta: { width: 1920, height: 1080 } },
    },
    generate_image: {
      responseText: 'Generated image from prompt.',
      responseData: {
        ...state,
        media: {
          type: 'image',
          mimeType: 'image/png',
          bucket: process.env.EXPRESS_S3_APP_BUCKET || process.env.EXPRESS_S3_TEMP_BUCKET,
          key: `agents/media/generate_image/${randomUUID()}.png`,
        },
      },
    },
    extend_image: {
      responseText: 'Extended image based on existing media.',
      responseData: {
        ...state,
        media: {
          type: 'image',
          mimeType: 'image/png',
          bucket: process.env.EXPRESS_S3_APP_BUCKET || process.env.EXPRESS_S3_TEMP_BUCKET,
          key: `agents/media/extend_image/${randomUUID()}.png`,
        },
      },
    },
    generate_video: {
      responseText: 'Generated video from prompt.',
      responseData: {
        ...state,
        media: {
          type: 'video',
          mimeType: 'video/mp4',
          bucket: process.env.EXPRESS_S3_APP_BUCKET || process.env.EXPRESS_S3_TEMP_BUCKET,
          key: `agents/media/generate_video/${randomUUID()}.mp4`,
        },
      },
    },
    extend_video: {
      responseText: 'Extended video based on existing media.',
      responseData: {
        ...state,
        media: {
          type: 'video',
          mimeType: 'video/mp4',
          bucket: process.env.EXPRESS_S3_APP_BUCKET || process.env.EXPRESS_S3_TEMP_BUCKET,
          key: `agents/media/extend_video/${randomUUID()}.mp4`,
        },
      },
    },
    classify_content: {
      responseText: 'Classified content category.',
      responseData: { ...state, categories: ['finance', 'report'], confidence: 0.86 },
    },
    detect_sensitivity: {
      responseText: 'Detected content sensitivity flags.',
      responseData: { ...state, flags: ['pii'], risk: 'medium' },
    },
    auto_tag: {
      responseText: 'Generated auto tags for content.',
      responseData: { ...state, tags: ['document', 'report', 'finance'] },
    },
    generate_caption: {
      responseText: 'Generated caption for media.',
      responseData: { ...state, caption: 'A document with tables and text.' },
    },
    suggest_keywords: {
      responseText: 'Suggested descriptive keywords.',
      responseData: { ...state, keywords: ['report', 'finance'] },
    },
    generate_description: {
      responseText: 'Generated detailed description.',
      responseData: { ...state, description: 'Detailed description of media.' },
    },
    summarize: {
      responseText: 'Summarized content.',
      responseData: { ...state, summary: 'Short summary of content.' },
    },
    extract_info: {
      responseText: 'Extracted key information.',
      responseData: { ...state, keyInfo: { title: 'sample', count: 10 } },
    },
  };

  if (!operations[capability]) {
    return {
      responseText: `Executed capability: ${capabilityName}`,
      responseData: { ...state, status: 'completed' },
    };
  }

  return operations[capability];
}
