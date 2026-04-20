// Versioned envelope wrapping every `--json` CLI output. `schema_version` is
// separate from the CLI's package version so consumers (the `/blog` skill,
// external automation) can parse stable shapes across patch releases.
//
// `kind` identifies the payload — new kinds can be added without bumping the
// envelope version; breaking changes bump `schema_version`.

export const JSON_ENVELOPE_VERSION = '1' as const;

export interface JsonEnvelope<K extends string, D> {
  schema_version: typeof JSON_ENVELOPE_VERSION;
  kind: K;
  generated_at: string;
  data: D;
}

export function makeEnvelope<K extends string, D>(kind: K, data: D): JsonEnvelope<K, D> {
  return {
    schema_version: JSON_ENVELOPE_VERSION,
    kind,
    generated_at: new Date().toISOString(),
    data,
  };
}

export function printEnvelope<K extends string, D>(kind: K, data: D): void {
  const env = makeEnvelope(kind, data);
  process.stdout.write(JSON.stringify(env, null, 2) + '\n');
}
