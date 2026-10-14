import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

describe('transcription file entry', () => {
  it('confirms cancellation in the card without waiting for another status poll', async () => {
    const dom = new JSDOM('<button id="transcribeRecording"></button><details id="attachmentMenu"></details><section id="transcriptionJobs" hidden></section>', { url: 'https://local.test/' });
    const oldWindow = globalThis.window;
    const oldDocument = globalThis.document;
    Object.assign(globalThis, { window: dom.window, document: dom.window.document });
    const cancel = vi.fn(async () => ({ ok: true as const, data: true }));
    Object.defineProperty(dom.window, 'api', { value: {
      transcriptionStartFile: async () => ({ ok: true as const, data: { id: 'job-cancel', name: 'meeting.wav' } }),
      transcriptionStatus: async () => ({ ok: true as const, data: { id: 'job-cancel', state: 'running', provider: 'groq', stage: 'Preparing verified local models' } }),
      transcriptionCancel: cancel
    } });
    try {
      const { initTranscriptionJobs } = await import('../src/renderer/transcription-jobs.js');
      initTranscriptionJobs(() => 'session-123');
      dom.window.document.querySelector<HTMLButtonElement>('#transcribeRecording')!.click();
      await vi.waitFor(() => expect(dom.window.document.querySelector('.transcription-job')?.textContent).toContain('Cloud · Groq · audio uploaded'));
      dom.window.document.querySelector<HTMLButtonElement>('.transcription-job button')!.click();
      await vi.waitFor(() => expect(dom.window.document.querySelector('.transcription-job')?.textContent).toContain('cancelled'));
      expect(cancel).toHaveBeenCalledWith('job-cancel');
    } finally {
      Object.assign(globalThis, { window: oldWindow, document: oldDocument });
      dom.window.close();
    }
  });
  it('starts an opaque job, shows speaker-labelled output, and renames its labels', async () => {
    const dom = new JSDOM('<button id="transcribeRecording"></button><details id="attachmentMenu"></details><section id="transcriptionJobs" hidden></section>', { url: 'https://local.test/' });
    const oldWindow = globalThis.window;
    const oldDocument = globalThis.document;
    Object.assign(globalThis, { window: dom.window, document: dom.window.document });
    const start = vi.fn(async () => ({ ok: true as const, data: { id: 'job-1', name: 'meeting.wav' } }));
    const status = vi.fn(async () => ({ ok: true as const, data: {
      id: 'job-1', state: 'completed', provider: 'local', stage: 'Completed',
      transcript: { segments: [{ speaker_id: 'S1', text: 'Good morning.' }] }
    } }));
    Object.defineProperty(dom.window, 'api', { value: { transcriptionStartFile: start, transcriptionStatus: status } });
    try {
      const { initTranscriptionJobs } = await import('../src/renderer/transcription-jobs.js');
      initTranscriptionJobs(() => 'session-123');
      dom.window.document.querySelector<HTMLButtonElement>('#transcribeRecording')!.click();
      await vi.waitFor(() => expect(dom.window.document.querySelector('.transcription-lines')?.textContent).toContain('S1: Good morning.'));
      expect(start).toHaveBeenCalledOnce();
      expect(start).toHaveBeenCalledWith('session-123');
      expect(status).toHaveBeenCalledWith('job-1');
      expect(dom.window.document.querySelector('.transcription-job')?.textContent).toContain('audio stays on this computer');
      const input = dom.window.document.querySelector<HTMLInputElement>('.transcription-speakers input')!;
      input.value = 'Alex';
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      expect(dom.window.document.querySelector('.transcription-lines')?.textContent).toContain('Alex: Good morning.');
    } finally {
      Object.assign(globalThis, { window: oldWindow, document: oldDocument });
      dom.window.close();
    }
  });
});
