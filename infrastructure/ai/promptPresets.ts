import { localStorageAdapter } from '../persistence/localStorageAdapter';
import { STORAGE_KEY_AI_PROMPT_PRESETS } from '../config/storageKeys';

/** Registry of all user-customizable AI prompt IDs. */
export const AI_PROMPT_IDS = ['catty:system', 'catty:compaction', 'catty:review'] as const;
export type AIPromptId = (typeof AI_PROMPT_IDS)[number];

/** User-editable overrides for AI prompts. Missing/empty values fall back to the code defaults. */
export interface AIPromptPresets {
  /** promptId -> user text. Absent or empty string = use the shipped default. */
  overrides: Partial<Record<AIPromptId, string>>;
}

export const DEFAULT_AI_PROMPT_PRESETS: AIPromptPresets = { overrides: {} };

export function loadPromptPresets(): AIPromptPresets {
  try {
    const raw = localStorageAdapter.read<AIPromptPresets>(STORAGE_KEY_AI_PROMPT_PRESETS);
    if (!raw || typeof raw !== 'object' || !raw.overrides || typeof raw.overrides !== 'object') {
      return { ...DEFAULT_AI_PROMPT_PRESETS, overrides: {} };
    }
    // Sanitise: keep only known ids, drop empty strings (treated as "reset to default").
    const overrides: Partial<Record<AIPromptId, string>> = {};
    for (const id of AI_PROMPT_IDS) {
      const v = raw.overrides[id];
      if (typeof v === 'string' && v.trim().length > 0) {
        overrides[id] = v;
      }
    }
    return { overrides };
  } catch {
    // localStorage unavailable (Node test env, SSR, etc.) — treat as no override.
    return { ...DEFAULT_AI_PROMPT_PRESETS, overrides: {} };
  }
}

export function savePromptPresets(presets: AIPromptPresets): void {
  localStorageAdapter.write(STORAGE_KEY_AI_PROMPT_PRESETS, presets);
}

/** Return the user override for a promptId, or undefined if the user has not customised it. */
export function getCustomPrompt(promptId: AIPromptId): string | undefined {
  const presets = loadPromptPresets();
  const v = presets.overrides[promptId];
  return typeof v === 'string' && v.trim().length > 0 ? v : undefined;
}
