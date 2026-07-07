export interface MatchedRoute {
  params: Record<string, string>;
}

export function matchPath(pattern: string, path: string): MatchedRoute | null {
  const patternSegments = pattern.split('/').filter(Boolean);
  const pathSegments = path.split('/').filter(Boolean);

  if (patternSegments.length !== pathSegments.length) {
    return null;
  }

  const params: Record<string, string> = {};
  for (const [index, segment] of patternSegments.entries()) {
    const pathSegment = pathSegments[index];
    if (segment.startsWith(':')) {
      try {
        params[segment.slice(1)] = decodeURIComponent(pathSegment);
      } catch {
        return null;
      }
    } else if (segment !== pathSegment) {
      return null;
    }
  }

  return { params };
}
