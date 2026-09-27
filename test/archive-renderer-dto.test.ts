import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_RENDERER_ERROR_MAX_CHARS,
  archiveRebuildForRenderer,
  archiveStatusForRenderer,
  sanitizeArchiveRendererError
} from '../src/shared/archive-renderer.js';

describe('archive renderer DTO boundary', () => {
  it('drops runtime filesystem/index internals and scrubs path-bearing status errors', () => {
    const sentinel = 'C:\\Users\\example\\archive-secret\\site\\index.html';
    const status = archiveStatusForRenderer({
      initialized: true,
      disposed: false,
      queuedSessions: 2,
      reconcilingSessions: 1,
      lastReconciledAt: 123,
      lastDerivedAt: 456,
      lastError: `Integrity read failed at ${sentinel}`,
      index: { documents: 14 },
      staticSite: { archiveRoot: 'C:\\Users\\example\\archive-secret', siteRoot: 'C:\\Users\\example\\archive-secret\\site', indexPath: sentinel },
      lastReconciledSessionId: 'session-private'
    } as Parameters<typeof archiveStatusForRenderer>[0] & Record<string, unknown>);

    expect(status).toEqual({
      initialized: true,
      disposed: false,
      queuedSessions: 2,
      reconcilingSessions: 1,
      lastReconciledAt: 123,
      lastDerivedAt: 456,
      lastError: 'Archive runtime reported an error.',
      indexedDocuments: 14
    });
    expect(JSON.stringify(status)).not.toContain('archive-secret');
    expect(JSON.stringify(status)).not.toContain('index.html');
    expect(status).not.toHaveProperty('staticSite');
    expect(status).not.toHaveProperty('lastReconciledSessionId');
  });

  it('returns only rebuild counts even when the runtime result carries native site paths', () => {
    const result = archiveRebuildForRenderer({
      chats: 7,
      index: { documents: 21 },
      staticSite: {
        archiveRoot: '/Users/private/archive-secret',
        siteRoot: '/Users/private/archive-secret/site',
        indexPath: '/Users/private/archive-secret/site/index.html'
      }
    } as Parameters<typeof archiveRebuildForRenderer>[0] & Record<string, unknown>);

    expect(result).toEqual({ chats: 7, indexedDocuments: 21 });
    expect(JSON.stringify(result)).not.toContain('archive-secret');
    expect(result).not.toHaveProperty('staticSite');
  });

  it('fails closed on native paths and bounds path-free shell/runtime errors', () => {
    const windowsSentinel = 'shell refused C:\\Private Sentinel\\archive\\index.html';
    const posixSentinel = 'ENOENT at /private/sentinel/archive/index.html';
    expect(sanitizeArchiveRendererError(windowsSentinel, 'Static archive could not be opened.'))
      .toBe('Static archive could not be opened.');
    expect(sanitizeArchiveRendererError(posixSentinel, 'Archive rebuild failed.'))
      .toBe('Archive rebuild failed.');
    expect(sanitizeArchiveRendererError(new Error(`runtime failed at ${windowsSentinel}`), 'Archive status is unavailable.'))
      .toBe('Archive status is unavailable.');
    expect(sanitizeArchiveRendererError({ path: windowsSentinel }, 'Archive operation failed.'))
      .toBe('Archive operation failed.');

    const longSafeError = 'x'.repeat(ARCHIVE_RENDERER_ERROR_MAX_CHARS + 50);
    const sanitized = sanitizeArchiveRendererError(longSafeError, 'Archive operation failed.');
    expect(sanitized).toHaveLength(ARCHIVE_RENDERER_ERROR_MAX_CHARS);
    expect(sanitized.endsWith('…')).toBe(true);
  });
});
