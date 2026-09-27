import type { ReasoningEffort } from './session.js';

/** ChatGPT-native browser modes that are not API/model reasoning-effort levels. */
export type NativeChatMode = 'think';

/** Normalized image bytes only. No local filesystem path crosses into the renderer. */
export interface InputImage { name: string; dataUrl: string; }
/** Upload metadata without a local path. Outbox ids require immutable staging;
 * recorded native-message ids are presentation metadata and grant no file access. */
export interface InputAttachment { id: string; name: string; size: number; mimeType: string; preview?: string; }
export type InputAutomation = 'off' | 'goal' | 'loop';

/** Finish tasks continue the chat; their old enqueue-time picker is not a new
 * model choice. Apply this projection to legacy queues too, preserving authored
 * fields for idempotent retries and keeping delivery/history on the same rule. */
export function browserInputModel(input: { mode: string; model: string | null; reasoningEffort: ReasoningEffort | null; nativeMode?: NativeChatMode | null }): { model: string | null; reasoningEffort: ReasoningEffort | null; nativeMode: NativeChatMode | null } {
  return input.mode === 'finish'
    ? { model: null, reasoningEffort: null, nativeMode: null }
    : { model: input.model, reasoningEffort: input.reasoningEffort, nativeMode: input.nativeMode ?? null };
}
