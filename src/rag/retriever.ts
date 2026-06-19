/**
 * Pure-JS TF-IDF retriever for Chinese text.
 * Zero dependencies, zero downloads, fully offline.
 */

export interface Chunk {
  id: string;
  content: string;
  chapterIndex?: number; // 0-based chapter index, used for range filtering
}

interface DocVector {
  id: string;
  vector: Float64Array;
}

// Build vocabulary from a corpus of character bigrams
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (let i = 0; i < text.length - 1; i++) {
    tokens.push(text[i] + text[i + 1]);
  }
  return tokens;
}

export class Retriever {
  private docs: DocVector[] = [];
  private idf = new Map<string, number>();
  private averageDocLength = 0;
  private chunks: Chunk[] = [];

  constructor(documents: Chunk[]) {
    void 0; // placeholder for empty constructor call from fromCache()
    this.chunks = documents;
    const docCount = documents.length;

    // Count document frequency for each token
    let totalLength = 0;
    const allTokenized: string[][] = [];

    for (const doc of documents) {
      const tokens = tokenize(doc.content);
      allTokenized.push(tokens);
      totalLength += tokens.length;

      const unique = new Set(tokens);
      for (const t of unique) {
        this.idf.set(t, (this.idf.get(t) || 0) + 1);
      }
    }

    this.averageDocLength = docCount > 0 ? totalLength / docCount : 1;

    // Compute IDF
    for (const [t, df] of this.idf) {
      this.idf.set(t, Math.log((docCount - df + 0.5) / (df + 0.5) + 1));
    }

    // Build document vectors
    for (let i = 0; i < documents.length; i++) {
      const tokens = allTokenized[i];
      const tf = new Map<string, number>();

      for (const t of tokens) {
        tf.set(t, (tf.get(t) || 0) + 1);
      }

      // Normalize by doc length (BM25-like)
      const docLen = tokens.length;
      for (const [t, count] of tf) {
        const normCount =
          (count * 2.2) / (count + 1.2 * (0.25 + 0.75 * (docLen / this.averageDocLength)));
        tf.set(t, normCount);
      }

      // Sparse vector → dense for cosine comparison
      // Use top 128 tokens by TF-IDF for efficiency
      const scored = Array.from(tf.entries())
        .map(([t, f]) => ({ token: t, score: f * (this.idf.get(t) || 0) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 128);

      const vector = new Float64Array(128);
      for (const s of scored) {
        // Hash token to a slot in the vector
        const slot = Math.abs(this.hashToken(s.token)) % 128;
        vector[slot] += s.score;
      }

      // Normalize
      const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0)) || 1;
      for (let j = 0; j < 128; j++) vector[j] /= norm;

      this.docs.push({ id: documents[i].id, vector });
    }
  }

  /** 从缓存数据重建 Retriever（跳过构造函数的全量计算） */
  static fromCache(chunks: Chunk[], vectorsBuffer: ArrayBuffer, idfMapJson: string): Retriever {
    const r = Object.create(Retriever.prototype) as Retriever;
    r.docs = [];
    r.chunks = chunks;
    r.idf = new Map(Object.entries(JSON.parse(idfMapJson)));
    r.averageDocLength = 1; // 不影响搜索，仅影响构建时的 TF 归一化

    const f32 = new Float32Array(vectorsBuffer);
    const dim = 128;
    for (let i = 0; i < chunks.length; i++) {
      const vector = new Float64Array(dim);
      for (let j = 0; j < dim; j++) {
        vector[j] = f32[i * dim + j];
      }
      r.docs.push({ id: chunks[i].id, vector });
    }
    return r;
  }

  /** 序列化为可存入 ragCache 的格式 */
  toCache(): { vectorsBuffer: ArrayBuffer; extraData: string } {
    const dim = 128;
    const f32 = new Float32Array(this.docs.length * dim);
    for (let i = 0; i < this.docs.length; i++) {
      for (let j = 0; j < dim; j++) {
        f32[i * dim + j] = this.docs[i].vector[j];
      }
    }
    return {
      vectorsBuffer: f32.buffer,
      extraData: JSON.stringify(Object.fromEntries(this.idf)),
    };
  }

  private hashToken(token: string): number {
    let hash = 0;
    for (let i = 0; i < token.length; i++) {
      hash = (hash * 31 + token.charCodeAt(i)) | 0;
    }
    return hash;
  }

  search(query: string, topK: number = 10): { id: string; score: number }[] {
    const qTokens = tokenize(query);
    if (qTokens.length === 0) return [];

    // Build query vector
    const tf = new Map<string, number>();
    for (const t of qTokens) {
      tf.set(t, (tf.get(t) || 0) + 1);
    }

    const qVector = new Float64Array(128);
    for (const [t, count] of tf) {
      const slot = Math.abs(this.hashToken(t)) % 128;
      qVector[slot] += count * (this.idf.get(t) || 0);
    }
    const qNorm = Math.sqrt(qVector.reduce((s, v) => s + v * v, 0)) || 1;
    for (let j = 0; j < 128; j++) qVector[j] /= qNorm;

    // Cosine similarity
    const results = this.docs.map((doc) => {
      let dot = 0;
      for (let j = 0; j < 128; j++) {
        dot += qVector[j] * doc.vector[j];
      }
      return { id: doc.id, score: dot };
    });

    return results.sort((a, b) => b.score - a.score).slice(0, topK);
  }
}
