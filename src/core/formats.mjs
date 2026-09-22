/** A release accepts exactly one current document family version; no fallback. */
export const FORMAT_VERSION = 3;
export const schema = kind => `workspace-recover/${kind}/v${FORMAT_VERSION}`;
export function assertFormat(document, kind) {
  if (!document || document.schema !== schema(kind)) {
    throw new Error(`unsupported ${kind} schema: expected ${schema(kind)}, got ${document?.schema ?? 'missing'}. Use the tool release for that format.`);
  }
  return document;
}

export const FEATURES = new Set(['advisory-workflow','saved-reports','named-actions','batch-inputs','google-workspace','local-files','tar-gzip','pax-paths','safe-merge','selection-inventory','archive-profiles']);
export function assertRequirements(requires) {
  if (requires===undefined)return;
  if (!requires || typeof requires!=='object' || Array.isArray(requires))throw new Error('requires must be an object');
  if(requires.formatVersion!==FORMAT_VERSION)throw new Error(`unsupported required formatVersion: ${requires.formatVersion}`);
  if(requires.features!==undefined && (!Array.isArray(requires.features) || requires.features.some(x=>!FEATURES.has(x))))throw new Error('unsupported required feature/capability');
}
export function assertTransport(transport) {
  assertFormat(transport,'transport-manifest');
  if(!/^[a-z0-9][a-z0-9.-]{0,31}$/.test(transport.archive?.format||''))throw new Error('unsupported archive format');
  if(!Number.isSafeInteger(transport.archive.bytes) || transport.archive.bytes<0 || !/^[a-f0-9]{64}$/.test(transport.archive.sha256 || ''))throw new Error('invalid transport archive size or SHA256');
  if(!Array.isArray(transport.parts) || !transport.parts.length)throw new Error('transport requires parts');
  for(const p of transport.parts)if(!Number.isSafeInteger(p.bytes) || p.bytes<0 || !/^[a-f0-9]{64}$/.test(p.sha256 || '') || typeof p.remote?.id!=='string')throw new Error('invalid transport part metadata');
}
