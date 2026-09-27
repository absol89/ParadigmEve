import { safeExternalLink } from './external-link.js';

export type ResourceDestination =
  | { kind: 'external'; url: string }
  | { kind: 'local'; path: string };

const MAX_RESOURCE_DESTINATION_CHARS = 8_192;
const WINDOWS_INVALID_SEGMENT = /[<>:"|?*]/u;
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/u;

function safeWindowsAbsolutePath(value: string): boolean {
  if (!/^[A-Za-z]:\\/u.test(value) || value.includes('/')) return false;
  const rest = value.slice(3);
  if (!rest) return true;
  const segments = rest.split('\\');
  return segments.every((segment, index) => {
    if (!segment) return index === segments.length - 1;
    if (segment === '.' || segment === '..') return false;
    if (WINDOWS_INVALID_SEGMENT.test(segment)) return false;
    return !/[. ]$/u.test(segment);
  });
}

function safePosixAbsolutePath(value: string): boolean {
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return false;
  if (value === '/') return true;
  const segments = value.slice(1).split('/');
  return segments.every((segment, index) => {
    if (!segment) return index === segments.length - 1;
    return segment !== '.' && segment !== '..';
  });
}

/** Absolute native resource paths only. No relative paths, shell syntax, file:// URLs or traversal. */
export function safeAbsoluteLocalPath(value: string): boolean {
  if (!value || value.length > MAX_RESOURCE_DESTINATION_CHARS || value !== value.trim() || CONTROL_CHAR.test(value)) return false;
  return safeWindowsAbsolutePath(value) || safePosixAbsolutePath(value);
}

/** A Thread destination is either an existing strict external-link shape or an absolute local resource locator. */
export function classifyResourceDestination(value: string): ResourceDestination | null {
  if (safeExternalLink(value)) return { kind: 'external', url: value };
  if (safeAbsoluteLocalPath(value)) return { kind: 'local', path: value };
  return null;
}

export function safeResourceDestination(value: string): boolean {
  return classifyResourceDestination(value) !== null;
}
