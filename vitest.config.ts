import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Transcription/Whisper are optional, candidate-tested features. Keep every
    // dedicated suite on the laptop, but do not require them on GitHub CI hosts.
    exclude: [...configDefaults.exclude, ...(process.env.CI ? ['test/transcription-*.test.ts'] : [])],
    environment: 'node',
    // This suite mixes real filesystem work, child processes, HTTP servers, Electron/native
    // helpers and worker threads. On an 8-way Windows host Vitest's full file parallelism can
    // starve otherwise-bounded tests long enough to create unrelated timeout/timing failures.
    // Four workers kept the existing 30 s contracts stable without serializing the suite.
    maxWorkers: 4,
    // Real filesystem, real child processes and a real HTTP server, so the
    // defaults are too tight.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      // Never let a test bind — or worse, fall through to — the shipped bridge range.
      // The developer's own installed app is usually listening on 8765 while the suite
      // runs, and a test that lost the bind race used to talk to it with a test token.
      CLF_BRIDGE_PORTS: '0',
      // In-process evidence arrives in microseconds or never; the production windows only
      // exist for a real browser that is seconds late. Without this the suite spent minutes
      // waiting out fifteen-second timeouts to prove calls stay unattributed.
      CLF_EVIDENCE_MS: '1500'
    }
  }
});
