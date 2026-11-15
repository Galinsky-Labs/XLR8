// Server configuration. Secrets never reach the browser: /config.json exposes
// only the explicitly public subset returned by publicConfig().
export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const databaseUrl = env.DATABASE_URL ?? '';
  if (production && !databaseUrl) throw new Error('DATABASE_URL is required in production');
  return Object.freeze({
    production,
    port: Number(env.PORT ?? 3000),
    databaseUrl,
    migrationDatabaseUrl: env.MIGRATION_DATABASE_URL || databaseUrl,
    publicOrigin: env.PUBLIC_ORIGIN ?? '',
    sessionHours: Math.min(168, Math.max(1, Number(env.SESSION_HOURS ?? 12))),
    guestDays: Math.min(30, Math.max(1, Number(env.GUEST_DAYS ?? 7))),
    // The 3D venue is provided by Browser-VR-Engine. Until its R12 release exists
    // there is no engine endpoint to configure and the venue is explicitly unavailable.
    engineServiceUrl: env.ENGINE_SERVICE_URL ?? ''
  });
}

export function publicConfig(config) {
  return { engine: engineStatus(config), product: 'XLR8' };
}

export const ENGINE_DEPENDENCY = Object.freeze({
  repository: 'Galinsky-Labs/Browser-VR-Engine',
  contract: '@browser-vr-engine/contracts',
  requiredRelease: 'BVR-R12',
  pinnedCommit: null
});

export function engineStatus(config) {
  if (!config.engineServiceUrl || !ENGINE_DEPENDENCY.pinnedCommit) {
    return { state: 'unavailable', reason: 'The Browser-VR-Engine release (R12) that XLR8 venues require has not been published. Agenda, registration and invitations work; 3D rooms are disabled.', dependency: ENGINE_DEPENDENCY };
  }
  return { state: 'configured', dependency: ENGINE_DEPENDENCY };
}
