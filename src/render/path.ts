/**
 * Resolves a dotted path (e.g. "extremes.0.time") against a context object,
 * treating numeric segments as array/object index access.
 */
export function resolvePath(context: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((value, segment) => {
    if (value === undefined || value === null) return undefined;
    return (value as Record<string, unknown>)[segment];
  }, context);
}
