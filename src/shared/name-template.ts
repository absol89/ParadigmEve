/**
 * Turn app-authored text that has a per-install name baked into it back into its catalog template,
 * with `{0}` where the name stood. Only whole-word matches count, so the default name "Eve" is not
 * found inside "ParadigmEve" and "Eva" is not found inside "Evaluate".
 */
export function templateWithName(text: string, name: string): string {
  if (!name) return text;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'gu'), '{0}');
}
