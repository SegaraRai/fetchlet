/** Waku loads it by name from `buildEnhancers`; apps do not call it. */
export default function buildEnhancer<Build extends (...args: never[]) => Promise<void>>(
  build: Build,
): Promise<Build>;
