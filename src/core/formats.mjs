/** A release accepts exactly one current document family version; no fallback. */
export const FORMAT_VERSION = 2;
export const schema = kind => `workspace-recover/${kind}/v${FORMAT_VERSION}`;
export function assertFormat(document, kind) {
  if (!document || document.schema !== schema(kind)) {
    throw new Error(`unsupported ${kind} schema: expected ${schema(kind)}, got ${document?.schema ?? 'missing'}. Use the tool release for that format.`);
  }
  return document;
}
