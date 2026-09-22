import { LocalFilesProvider } from '../providers/local-files.mjs';
import { GoogleWorkspaceProvider } from '../providers/google-workspace.mjs';

export function providerFromConfig(config, overrides = {}) {
  if (!config?.type) throw new Error('provider type is required');
  if (config.type === 'local-files') return new LocalFilesProvider({ ...config, ...overrides });
  if (config.type === 'google-workspace') return new GoogleWorkspaceProvider({ ...config, ...overrides });
  throw new Error(`unsupported provider type: ${config.type}`);
}

export function handoffProviderFromReference(reference, { googleProfile = 'default' } = {}) {
  if (/^https:\/\/mail\.google\.com\//.test(reference) || /^[0-9a-f]{12,}$/i.test(reference)) {
    return new GoogleWorkspaceProvider({ profile: googleProfile });
  }
  return new LocalFilesProvider({ root: '.', handoffRoot: '.' });
}
