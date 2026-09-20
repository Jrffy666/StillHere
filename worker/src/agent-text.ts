/** Best-effort bounded minimization, not guaranteed anonymity or a live-AI consent mechanism. */
export function redactAgentText(text: string, maxLength = 600): string {
  const limit = Math.max(0, Math.min(2000, Number.isFinite(maxLength) ? Math.floor(maxLength) : 600));
  return text.slice(0, 10_000)
    // Remove complete coordinate pairs before phone matching can obscure only one half.
    .replace(/-?\b\d{1,3}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}\b/g, '[redacted coordinates]')
    .replace(/\b(?:https?:\/\/|www\.)[^\s<>"']+/gi, '[redacted URL]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted email]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\bshpa_[a-f0-9]{64}\b/gi, '[redacted capability]')
    .replace(/\b(?:api[_ -]?key|access[_ -]?token|token|secret|password)\s*[:=]\s*["']?[^\s,;"']+["']?/gi, '[redacted credential]')
    .replace(/\b(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{8,}\b/g, '[redacted credential]')
    .replace(/\b0x[A-Fa-f0-9]{32,}\b/g, '[redacted identifier]')
    .replace(/\+?\d(?:[\s().-]*\d){7,}\b/g, '[redacted phone]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .slice(0, limit);
}
