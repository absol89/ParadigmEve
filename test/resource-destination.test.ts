import { describe, expect, it } from 'vitest';
import { classifyResourceDestination, safeAbsoluteLocalPath, safeResourceDestination } from '../src/shared/resource-destination.js';

describe('resource destinations', () => {
  it.each([
    'C:\\Builds\\Example-installers',
    'C:\\Builds\\Example-installers\\ParadigmEve-2.2.3-x64-Angel.exe',
    'C:\\Projects\\MySite\\report.html'
  ])('accepts an absolute Windows resource path: %s', value => {
    expect(safeAbsoluteLocalPath(value)).toBe(true);
    expect(classifyResourceDestination(value)).toEqual({ kind: 'local', path: value });
  });

  it.each(['https://example.com/docs', 'http://localhost:3000/', 'mailto:person@example.com'])
  ('preserves the strict external-link path: %s', value => {
    expect(safeResourceDestination(value)).toBe(true);
    expect(classifyResourceDestination(value)?.kind).toBe('external');
  });

  it.each([
    'relative\\file.txt',
    '..\\file.txt',
    'C:relative\\file.txt',
    'C:\\Projects\\..\\secret.txt',
    'C:\\Projects\\bad?.txt',
    'file:///C:/Projects/report.html',
    'javascript:alert(1)',
    'data:text/html,hi'
  ])('fails closed on ambiguous or unsafe resource destinations: %s', value => {
    expect(safeResourceDestination(value)).toBe(false);
    expect(classifyResourceDestination(value)).toBeNull();
  });
});
