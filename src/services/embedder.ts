import os from 'node:os';
import path from 'node:path';

export interface Embedder {
  readonly model: string;
  /** Cosine floor below which semantic hits are treated as noise (model-specific). */
  readonly minSimilarity?: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export function toBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function fromBlob(b: Buffer): Float32Array {
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4));
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

export function createFastEmbedder(
  cacheDir: string = path.join(os.homedir(), '.central-brain', 'models'),
): Embedder {
  let modelPromise: Promise<any> | undefined;
  const load = () => {
    modelPromise ??= (async () => {
      const { FlagEmbedding, EmbeddingModel } = await import('fastembed');
      return FlagEmbedding.init({ model: EmbeddingModel.BGESmallENV15, cacheDir, showDownloadProgress: false });
    })();
    return modelPromise;
  };
  return {
    model: 'bge-small-en-v1.5',
    // Measured bge-small cutoff on live data: unrelated-query top1 0.56-0.638; a zero-keyword-overlap
    // paraphrase of a known fact scored 0.653. Thin margin — tune here if recall/noise drifts.
    minSimilarity: 0.64,
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      const m = await load();
      const out: Float32Array[] = [];
      for await (const batch of m.embed(texts, 32)) {
        for (const v of batch) out.push(Float32Array.from(v));
      }
      return out;
    },
  };
}

export function fakeEmbedder(dims = 32): Embedder {
  return {
    model: `fake-${dims}`,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map(t => {
        const v = new Float32Array(dims);
        for (const w of t.toLowerCase().split(/\W+/).filter(Boolean)) {
          let h = 0;
          for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
          v[h % dims] += 1;
        }
        return v;
      });
    },
  };
}
