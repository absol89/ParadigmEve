/**
 * Recognizable API credentials in authored text, including keys pasted into browser form/code
 * arguments rather than configured as plugin secrets. Do not treat arbitrary long identifiers,
 * hashes or image bytes as credentials: those must survive tool results and exact recordings.
 */
export function redactCredentialText(text: string): string {
  return text
    .replace(/-----BEGIN ((?:(?:RSA|EC|DSA|OPENSSH) )?PRIVATE KEY)-----[\s\S]{0,8192}?-----END \1-----/g, '[redacted private key]')
    .replace(/\bsk-(?:or-v1-|proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g, '[redacted]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[redacted]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[redacted]')
    .replace(/\bAIza[A-Za-z0-9_-]{35}\b/g, '[redacted]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{24,}\b/gi, 'Bearer [redacted]');
}
