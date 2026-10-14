import { $, el, run, toast } from './dom.js';
import type { TranscriptionJob } from '../shared/transcription.js';
import { t } from './i18n.js';

type Segment = { speaker_id?: string | null; text: string };

/** File chooser, job status and speaker-labelled transcript in the chat dock. */
export function initTranscriptionJobs(selectedSession: () => string | null): void {
  const container = $('transcriptionJobs');
  const jobs = new Map<string, { name: string; names: Map<string, string>; timer?: number }>();
  const render = (job: TranscriptionJob): void => {
    const local = jobs.get(job.id);
    const card = [...container.children].find(node => (node as HTMLElement).dataset.jobId === job.id) as HTMLElement | undefined;
    if (!local || !card) return;
    const route = job.provider === 'openai'
      ? t('Cloud · OpenAI · audio uploaded; speaker separation local')
      : job.provider === 'groq'
        ? t('Cloud · Groq · audio uploaded; speaker separation local')
        : job.provider === 'local'
          ? t('Local · audio stays on this computer')
          : job.avenue ?? '';
    // What actually ran, from the transcript's provenance; a fallback is shown, never hidden.
    const executed = job.backend === 'vulkan' || job.backend === 'metal'
      ? t('Ran on GPU: {0}', [job.device ?? job.backend])
      : job.backend === 'cpu' ? t('Ran on CPU') : '';
    const fallback = job.fallbacks?.length
      ? t('Fell back after: {0}', [job.fallbacks.map(item => item.avenue.toUpperCase()).join(', ')]) : '';
    const stage = [job.stage ? t(job.stage) : '', executed, fallback].filter(Boolean).join(' · ');
    card.replaceChildren(
      el('strong', '', local.name),
      el('p', 'muted', `${job.state}${route ? ` · ${route}` : ''}${stage ? ` · ${stage}` : ''}${job.error ? ` · ${job.error}` : ''}`)
    );
    if (job.state === 'running') {
      const cancel = el('button', 'btn', 'Cancel') as HTMLButtonElement;
      cancel.type = 'button';
      cancel.onclick = async () => {
        cancel.disabled = true;
        cancel.textContent = t('Cancelling…');
        const cancelled = await run(window.api.transcriptionCancel(job.id));
        if (cancelled) render({ ...job, state: 'cancelled', stage: 'Cancelled' });
        else await poll(job.id);
      };
      card.append(cancel);
    }
    if (job.state !== 'completed') return;
    const source = job.transcript && typeof job.transcript === 'object' && !Array.isArray(job.transcript)
      ? job.transcript as Record<string, unknown> : {};
    const segments: Segment[] = Array.isArray(source.segments)
      ? source.segments.filter((item): item is Segment => !!item && typeof item === 'object' && typeof item.text === 'string').slice(0, 10000) : [];
    if (!segments.length) { card.append(el('p', 'muted', 'No speaker-labelled segments returned.')); return; }
    const transcript = el('div', 'transcription-lines');
    const lineText = (segment: Segment): string => `${local.names.get(segment.speaker_id ?? 'Unknown') ?? segment.speaker_id ?? 'Unknown'}: ${segment.text}`;
    const paint = (): void => transcript.replaceChildren(...segments.map(segment => el('p', '', lineText(segment))));
    const speakers = el('div', 'transcription-speakers');
    for (const id of new Set(segments.map(segment => segment.speaker_id ?? 'Unknown'))) {
      const label = el('label', '', `${id} `);
      const input = document.createElement('input');
      input.value = local.names.get(id) ?? id;
      input.maxLength = 80;
      input.setAttribute('aria-label', `Name for speaker ${id}`);
      input.addEventListener('input', () => { local.names.set(id, input.value || id); paint(); });
      label.append(input); speakers.append(label);
    }
    const copy = el('button', 'btn', 'Copy transcript') as HTMLButtonElement;
    copy.type = 'button';
    copy.onclick = () => { void navigator.clipboard.writeText(segments.map(lineText).join('\n')).then(() => toast('Transcript copied')).catch(() => toast('Could not copy transcript')); };
    card.append(speakers, copy, transcript);
    paint();
  };
  const poll = async (id: string): Promise<boolean> => {
    const status = await run(window.api.transcriptionStatus(id));
    if (!jobs.has(id)) return false;
    if (!status) {
      const local = jobs.get(id);
      if (local?.timer !== undefined) window.clearInterval(local.timer);
      render({ id, state: 'failed', error: 'Could not retrieve transcription job status.' });
      return false;
    }
    render(status);
    if (status.state !== 'running') {
      const job = jobs.get(id);
      if (job?.timer !== undefined) window.clearInterval(job.timer);
    }
    return status.state === 'running';
  };
  $('transcribeRecording').addEventListener('click', async () => {
    ($('attachmentMenu') as HTMLDetailsElement).open = false;
    const sessionId = selectedSession();
    if (!sessionId) {
      toast('Open an existing conversation to save a durable transcript attachment.');
      return;
    }
    const button = $<HTMLButtonElement>('transcribeRecording');
    button.disabled = true;
    try {
      const started = await run(window.api.transcriptionStartFile(sessionId));
      if (!started) return;
      jobs.set(started.id, { name: started.name, names: new Map() });
      container.hidden = false;
      const card = el('article', 'transcription-job'); card.dataset.jobId = started.id;
      container.prepend(card);
      render({ id: started.id, state: 'running' });
      const running = await poll(started.id);
      const local = jobs.get(started.id);
      if (local && running) local.timer = window.setInterval(() => { void poll(started.id); }, 2500);
    } finally { button.disabled = false; }
  });
}
