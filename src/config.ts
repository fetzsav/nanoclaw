import path from 'path';

import { LocalLlmConfig } from './types.js';
import { loadJson } from './utils.js';

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Andy';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || '/Users/user';

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const MAIN_GROUP_FOLDER = 'main';

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '300000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Local LLM defaults
const LOCAL_LLM_DEFAULTS = {
  baseUrl: 'http://localhost:11434/v1',
  model: 'qwen2.5:7b',
  temperature: 0.7,
  maxTokens: 2048,
  timeout: 300000,
};

export interface FullLocalLlmConfig {
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeout: number;
  apiKey?: string;
}

/**
 * Load local LLM config: defaults → data/local-llm-config.json → per-group overrides.
 */
export function loadLocalLlmConfig(groupOverrides?: LocalLlmConfig): FullLocalLlmConfig {
  const filePath = path.join(DATA_DIR, 'local-llm-config.json');
  const fileConfig = loadJson<Partial<FullLocalLlmConfig>>(filePath, {});

  return {
    baseUrl: fileConfig.baseUrl ?? LOCAL_LLM_DEFAULTS.baseUrl,
    model: groupOverrides?.model ?? fileConfig.model ?? LOCAL_LLM_DEFAULTS.model,
    temperature: groupOverrides?.temperature ?? fileConfig.temperature ?? LOCAL_LLM_DEFAULTS.temperature,
    maxTokens: groupOverrides?.maxTokens ?? fileConfig.maxTokens ?? LOCAL_LLM_DEFAULTS.maxTokens,
    timeout: fileConfig.timeout ?? LOCAL_LLM_DEFAULTS.timeout,
    apiKey: (fileConfig as Record<string, unknown>).apiKey as string | undefined,
  };
}
