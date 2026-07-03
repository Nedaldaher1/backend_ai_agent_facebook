/**
 * Abaya discrimination probe — the go/no-go for visual search.
 *
 *   pnpm embeddings:probe <dir> [--text "label a,label b,..."]
 *
 * Empirically answers: does the configured embedding model (gemini-embedding-2
 * via OpenRouter) produce DISCRIMINATIVE embeddings for abayas? i.e. do
 * visually-similar abayas score high cosine and different ones score lower? It
 * reuses the REAL EmbeddingService.embedImage (production code path, incl.
 * L2-normalization), so cosine = dot product.
 *
 * Standalone: NO database, NO R2, NO server. It boots a minimal Nest context
 * (ConfigModule + EmbeddingsModule) only to construct EmbeddingService exactly
 * as the app does, then loads the model once (lazily, ~seconds first call).
 *
 * Input layout (recommend the FIRST to the user):
 *   - <dir> with SUBDIRECTORIES → each subdir is a labeled style group
 *     (e.g. plain-black/, gold-embroidered/, kimono-cut/, 3–5 similar images
 *     each). Unlocks the quantitative intra-vs-inter metric + verdict.
 *   - <dir> FLAT (only image files) → one unlabeled set: matrix + nearest
 *     neighbours + spread only (no separation metric).
 *
 * What matters is the SEPARATION (intra-group vs inter-group), NOT the absolute
 * cosine values — embedding cosines can run high in absolute terms, so a raw
 * "0.9" between two images means nothing without the same-vs-different
 * comparison.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { Logger, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { EmbeddingService } from '@/modules/embeddings/embedding.service';
import { EmbeddingsModule } from '@/modules/embeddings/embeddings.module';
import { sniffImageMediaType } from '@/common/images/sniff-image.util';
import { ALLOWED_IMAGE_EXTENSIONS } from '@/core/storage/storage.constants';

/**
 * Minimal composition root for the probe: ConfigModule loads `.env` (so
 * EMBEDDING_* overrides are honored) WITHOUT env validation (no DATABASE_URL /
 * R2 / JWT required), and EmbeddingsModule provides the real EmbeddingService.
 * Deliberately does NOT import AppModule, so there is no DB/R2/HTTP coupling.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true }),
    EmbeddingsModule,
  ],
})
class ProbeModule {}

/** One embedded image: where it came from, its style group, its vector. */
interface Item {
  /** Basename for display (e.g. `img-03.jpg`). */
  file: string;
  /** Path relative to the input dir (e.g. `gold-embroidered/img-03.jpg`). */
  rel: string;
  /** Subdir name in labeled mode; `null` in flat mode. */
  group: string | null;
  vec: number[];
}

/** Verdict heuristics. These are STARTING POINTS to calibrate on real data —
 * read the raw numbers, don't treat the ✅/⚠️ as gospel. */
const MARGIN_GOOD = 0.03; // intra-mean − inter-mean clearly above 0
const NN_GOOD = 0.7; // ≥70% of images' top-1 neighbour is same-group
const SPREAD_GOOD = 0.08; // off-diagonal max − min shows real separation

const print = (line = ''): void => console.log(line);

function dot(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

/** Truncate a long label from the left so the distinctive tail stays visible. */
function ellipsize(s: string, width: number): string {
  return s.length <= width ? s : '…' + s.slice(s.length - width + 1);
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function std(xs: number[]): number {
  if (xs.length === 0) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) * (x - m))));
}

/** Collect image files one level deep: subdirs = labeled groups, root files = flat. */
function discover(dir: string): {
  items: Pick<Item, 'file' | 'rel' | 'group'>[];
  labeled: boolean;
  ignoredRoot: number;
} {
  const entries = readdirSync(dir, { withFileTypes: true });
  const isImage = (name: string): boolean =>
    ALLOWED_IMAGE_EXTENSIONS.has(extname(name).toLowerCase());

  const rootImages = entries
    .filter((e) => e.isFile() && isImage(e.name))
    .map((e) => ({ file: e.name, rel: e.name, group: null as string | null }));

  const subdirs = entries
    .filter((e) => e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
  const grouped: Pick<Item, 'file' | 'rel' | 'group'>[] = [];
  for (const sub of subdirs) {
    const subEntries = readdirSync(join(dir, sub.name), {
      withFileTypes: true,
    });
    for (const e of subEntries) {
      if (e.isFile() && isImage(e.name)) {
        grouped.push({
          file: e.name,
          rel: join(sub.name, e.name),
          group: sub.name,
        });
      }
    }
  }

  // Labeled mode the moment any subdir holds images; root-level loose files are
  // then ignored (they have no coherent style label).
  if (grouped.length > 0) {
    return { items: grouped, labeled: true, ignoredRoot: rootImages.length };
  }
  return { items: rootImages, labeled: false, ignoredRoot: 0 };
}

/** Grid-anchored (0.05) text histogram of the off-diagonal similarities. */
function histogram(sims: number[]): void {
  const lo = Math.floor(Math.min(...sims) / 0.05) * 0.05;
  const hi = Math.ceil(Math.max(...sims) / 0.05) * 0.05;
  const bins = Math.max(1, Math.round((hi - lo) / 0.05));
  const counts = new Array<number>(bins).fill(0);
  for (const v of sims) {
    const idx = Math.min(bins - 1, Math.max(0, Math.floor((v - lo) / 0.05)));
    counts[idx]++;
  }
  const peak = Math.max(...counts, 1);
  for (let i = 0; i < bins; i++) {
    const a = lo + i * 0.05;
    const b = a + 0.05;
    const bar = '#'.repeat(Math.round((counts[i] / peak) * 40));
    print(`  [${a.toFixed(2)}, ${b.toFixed(2)})  ${pad(bar, 40)} ${counts[i]}`);
  }
}

async function main(): Promise<void> {
  const logger = new Logger('embeddings:probe');

  // --- args ---
  const argv = process.argv.slice(2);
  const textIdx = argv.indexOf('--text');
  const textValIdx = textIdx >= 0 ? textIdx + 1 : -1; // index of the --text value
  const labels =
    textValIdx >= 0 && argv[textValIdx]
      ? argv[textValIdx]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  // First positional arg that is neither a flag nor the value of --text.
  const dir = argv.find((a, i) => !a.startsWith('--') && i !== textValIdx);
  if (!dir) {
    print('usage: pnpm embeddings:probe <dir> [--text "label a,label b"]');
    print('  <dir> with subfolders = labeled style groups (recommended);');
    print('  flat <dir> = one unlabeled set (matrix + neighbours only).');
    process.exitCode = 1;
    return;
  }

  const found = discover(dir);
  if (found.items.length < 2) {
    logger.error(
      `need at least 2 images under ${dir}, found ${found.items.length}. ` +
        `Drop image files (or subfolders of images) there and retry.`,
    );
    process.exitCode = 1;
    return;
  }
  if (found.ignoredRoot > 0) {
    logger.warn(
      `labeled mode (subfolders present): ignoring ${found.ignoredRoot} loose ` +
        `image(s) in the root — put each in a style subfolder to include it.`,
    );
  }

  // --- model + embeddings (real production path) ---
  const app = await NestFactory.createApplicationContext(ProbeModule, {
    logger: ['error', 'warn', 'log'],
  });
  const items: Item[] = [];
  try {
    const embeddings = app.get(EmbeddingService);
    logger.log(
      `embedding ${found.items.length} images with ${embeddings.modelId} ` +
        `(${found.labeled ? 'labeled' : 'flat/unlabeled'} mode) …`,
    );
    let done = 0;
    for (const it of found.items) {
      const buffer = readFileSync(join(dir, it.rel));
      // embedImage now takes a URL; the probe holds local bytes, so it sends a
      // base64 data URL for the diagnostic run.
      const mediaType = sniffImageMediaType(buffer) ?? 'image/jpeg';
      const dataUrl = `data:${mediaType};base64,${buffer.toString('base64')}`;
      const vec = await embeddings.embedImage(dataUrl);
      items.push({ ...it, vec });
      logger.log(`  [${++done}/${found.items.length}] ${it.rel}`);
    }

    report(items, found.labeled);
    if (labels.length > 0)
      await reportText(app.get(EmbeddingService), labels, items);
  } finally {
    await app.close();
  }
}

/** Print the full decision-oriented report from the embedded items. */
function report(items: Item[], labeled: boolean): void {
  const n = items.length;
  const W = 30; // display column width for names

  // --- 1. per-image top-3 nearest neighbours ---
  print('');
  print('═══ Nearest neighbours (top-3 by cosine) ═══');
  for (let i = 0; i < n; i++) {
    const sims = items
      .map((other, j) => ({ j, s: dot(items[i].vec, other.vec) }))
      .filter((x) => x.j !== i)
      .sort((a, b) => b.s - a.s)
      .slice(0, 3);
    const self = labeled ? `${items[i].rel}` : items[i].file;
    const nn = sims
      .map((x) => {
        const o = items[x.j];
        const mark = labeled ? (o.group === items[i].group ? '=' : '≠') : ' ';
        const name = labeled ? o.rel : o.file;
        return `${mark}${ellipsize(name, W)} ${x.s.toFixed(3)}`;
      })
      .join('   ');
    print(`  ${pad(ellipsize(self, W), W)} → ${nn}`);
  }

  // --- 2 & 3. off-diagonal stats + histogram ---
  const offDiag: number[] = [];
  const intra: number[] = [];
  const inter: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = dot(items[i].vec, items[j].vec);
      offDiag.push(s);
      if (labeled && items[i].group !== null) {
        if (items[i].group === items[j].group) intra.push(s);
        else inter.push(s);
      }
    }
  }
  const oMin = Math.min(...offDiag);
  const oMax = Math.max(...offDiag);
  print('');
  print('═══ Off-diagonal similarity (all distinct image pairs) ═══');
  print(
    `  pairs=${offDiag.length}  min=${oMin.toFixed(3)}  max=${oMax.toFixed(3)}  ` +
      `mean=${mean(offDiag).toFixed(3)}  std=${std(offDiag).toFixed(3)}`,
  );
  print('');
  print('═══ Histogram of off-diagonal similarities ═══');
  print(
    "  (mass jammed near 1.0 → model can't separate; visible spread → it differentiates)",
  );
  histogram(offDiag);

  // --- 4. labeled metrics + 5. verdict ---
  print('');
  print('═══ Verdict ═══');
  print(
    '  NOTE: what matters is SEPARATION (intra vs inter), NOT absolute cosines. ' +
      'SigLIP cosines run high in absolute terms — a raw 0.9 is meaningless on its own.',
  );

  if (!labeled) {
    print('');
    print(
      `  Flat/unlabeled set → only spread is available: [${oMin.toFixed(3)} .. ${oMax.toFixed(3)}] (range ${(oMax - oMin).toFixed(3)}).`,
    );
    print(
      '  For a real go/no-go, re-run with each visual STYLE in its own subfolder',
    );
    print(
      '  (e.g. plain-black/, gold-embroidered/, kimono-cut/ — 3–5 similar images each).',
    );
    return;
  }

  if (intra.length === 0 || inter.length === 0) {
    print('');
    print(
      `  Labeled, but need ≥2 groups AND ≥2 images in a group for the metric ` +
        `(intra pairs=${intra.length}, inter pairs=${inter.length}).`,
    );
    print(
      '  Add more images per style and at least two distinct style folders, then re-run.',
    );
    return;
  }

  const intraMean = mean(intra);
  const interMean = mean(inter);
  const margin = intraMean - interMean;

  // nearest-neighbour-same-group rate over images that HAVE a same-group peer.
  const groupSize = new Map<string, number>();
  for (const it of items)
    if (it.group) groupSize.set(it.group, (groupSize.get(it.group) ?? 0) + 1);
  let eligible = 0;
  let sameGroupHits = 0;
  for (let i = 0; i < n; i++) {
    const g = items[i].group;
    if (!g || (groupSize.get(g) ?? 0) < 2) continue; // singleton can't hit
    eligible++;
    let best = -Infinity;
    let bestJ = -1;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const s = dot(items[i].vec, items[j].vec);
      if (s > best) {
        best = s;
        bestJ = j;
      }
    }
    if (bestJ >= 0 && items[bestJ].group === g) sameGroupHits++;
  }
  const nnRate = eligible === 0 ? 0 : sameGroupHits / eligible;
  const spread = oMax - oMin;

  print('');
  print(
    `  intra-group mean (same style):  ${intraMean.toFixed(3)}  (${intra.length} pairs)`,
  );
  print(
    `  inter-group mean (diff style):  ${interMean.toFixed(3)}  (${inter.length} pairs)`,
  );
  print(
    `  separation margin (intra−inter): ${margin >= 0 ? '+' : ''}${margin.toFixed(3)}`,
  );
  print(
    `  same-group NN rate:             ${(nnRate * 100).toFixed(0)}%  (${sameGroupHits}/${eligible} eligible images)`,
  );
  print(
    `  off-diagonal spread:            [${oMin.toFixed(3)} .. ${oMax.toFixed(3)}]  (range ${spread.toFixed(3)})`,
  );
  print('');

  const good =
    margin >= MARGIN_GOOD && nnRate >= NN_GOOD && spread >= SPREAD_GOOD;
  print(
    `  Separation margin = ${margin >= 0 ? '+' : ''}${margin.toFixed(3)} · ` +
      `same-group NN rate = ${(nnRate * 100).toFixed(0)}% · ` +
      `off-diagonal spread = [${oMin.toFixed(3)}..${oMax.toFixed(3)}].`,
  );
  if (good) {
    print(
      '  ✅ Embeddings discriminate — visual search is viable on this set.',
    );
  } else {
    const reasons: string[] = [];
    if (margin < MARGIN_GOOD)
      reasons.push(`margin ${margin.toFixed(3)} < ${MARGIN_GOOD}`);
    if (nnRate < NN_GOOD)
      reasons.push(
        `NN rate ${(nnRate * 100).toFixed(0)}% < ${(NN_GOOD * 100).toFixed(0)}%`,
      );
    if (spread < SPREAD_GOOD)
      reasons.push(`spread ${spread.toFixed(3)} < ${SPREAD_GOOD}`);
    print(`  ⚠️  Poor discrimination on this set (${reasons.join('; ')}).`);
    print(
      '     Visual search alone is unreliable here — consider fine-tuning on your',
    );
    print(
      '     catalog, or leaning on the attribute / Vision cascade instead.',
    );
  }
}

/** Optional text↔image probe: embed each label and report its nearest image. */
async function reportText(
  embeddings: EmbeddingService,
  labels: string[],
  items: Item[],
): Promise<void> {
  print('');
  print('═══ Text → nearest image (shared-space check) ═══');
  for (const label of labels) {
    const vec = await embeddings.embedText(label);
    let best = -Infinity;
    let bestI = -1;
    for (let i = 0; i < items.length; i++) {
      const s = dot(vec, items[i].vec);
      if (s > best) {
        best = s;
        bestI = i;
      }
    }
    const hit =
      bestI >= 0 ? `${items[bestI].rel} (${best.toFixed(3)})` : '(none)';
    print(`  "${label}"  →  ${hit}`);
  }
}

void main().catch((err: unknown) => {
  console.error('probe failed:', err);
  process.exit(1);
});
