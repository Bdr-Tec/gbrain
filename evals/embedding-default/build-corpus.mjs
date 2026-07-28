#!/usr/bin/env node
/**
 * Corpus builder for the embedding-default eval.
 *
 * Fetches REAL text (not LLM-generated) from Wikipedia for six language
 * slices — en / he / ar / ru / zh / ja — over the SAME semantic topic set, so
 * language + script is the only variable across slices.
 *
 * The slice set is chosen to separate two confounded explanations of the
 * Hebrew result in the first run:
 *   - `ar` is a SECOND right-to-left script  → does the RTL finding generalise?
 *   - `ru` is non-Latin but LEFT-to-right    → is "non-Latin" the real variable?
 * Keeping the topic set identical across all six is what makes that
 * comparison mean anything.
 *
 * Two outputs per slice:
 *   corpus/<slice>.jsonl        docs   — lead-section plaintext extract
 *   queries/<slice>.alias.jsonl queries — REAL Wikipedia redirect titles
 *
 * Why redirects are the zero-synthesis query family: a redirect on
 * he.wikipedia is a surface form a Hebrew-speaking human actually typed and
 * a Hebrew-speaking editor actually created. Nobody in this pipeline wrote
 * them. They are the entity-lookup query shape ("alice-example", "acme corp")
 * that dominates gbrain traffic.
 *
 * The natural-language-question family (queries/<slice>.nlq.jsonl) is
 * AUTHOR-WRITTEN and committed by hand, NOT produced here. It is labelled
 * synthetic in the receipt and reported separately — see README.md §Corpus.
 *
 * Wikipedia text is CC BY-SA 4.0. Every doc row records pageid + revid +
 * source_url so the exact revision is attributable and re-fetchable.
 *
 * Usage:  node build-corpus.mjs            # fetch + write
 *         node build-corpus.mjs --dry-run  # report coverage, write nothing
 *         node build-corpus.mjs --probe    # langlinks coverage only, no extracts
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

const LANGS = ['en', 'he', 'ar', 'ru', 'zh', 'ja'];
/** Docs per slice. The pool in topics.txt is over-provisioned; survivors of the
 *  six-way intersection are capped to this so every slice is the same size. */
const TARGET_DOCS = 200;
/** Drop a topic unless EVERY language's lead extract clears this. Keeps the
 *  topic set identical across slices (Hebrew + Arabic Wikipedia have more
 *  stubs than English). */
const MIN_DOC_CHARS = 300;
/** Cap doc length. ~2000 chars ≈ 500 tokens ≈ one gbrain chunk, so the eval
 *  measures the embedding and not the chunker. */
const MAX_DOC_CHARS = 2000;
/** Max real redirect aliases to keep per (topic, language). */
const MAX_ALIASES_PER_TOPIC = 3;
const BATCH = 20;
const SLEEP_MS = 1200;
/** Full-text extracts are one-request-per-title (see fetchExtracts). */
const FULLTEXT_SLEEP_MS = 400;

const UA = 'gbrain-embedding-default-eval/1.0 (https://github.com/garrytan/gbrain; maintainer eval)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(lang, params) {
  const url = `https://${lang}.wikipedia.org/w/api.php?${new URLSearchParams({
    format: 'json', formatversion: '2', ...params,
  })}`;
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await sleep(SLEEP_MS * (attempt + 2));
    }
  }
  throw lastErr;
}

function* chunk(arr, n) {
  for (let i = 0; i < arr.length; i += n) yield arr.slice(i, i + n);
}

/** Stable, language-independent doc id. Derived from the canonical EN title so
 *  the same topic carries the same slug in every slice. */
function slugify(enTitle) {
  return enTitle
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*$/, '')   // drop the disambiguator
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function readTopics() {
  return readFileSync(join(__dirname, 'topics.txt'), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

/** EN title -> { he, zh, ja } via the langlinks API (lllang filter keeps the
 *  response one row per page, so batching can't silently truncate). */
async function resolveTitles(topics) {
  const byEn = new Map(topics.map((t) => [t, { en: t }]));
  const alias = new Map(); // requested title -> canonical title after redirect/normalize
  for (const lang of LANGS.filter((l) => l !== 'en')) {
    for (const batch of chunk(topics, BATCH)) {
      const d = await api('en', {
        action: 'query', redirects: '1', prop: 'langlinks',
        lllang: lang, lllimit: 'max', titles: batch.join('|'),
      });
      for (const r of d.query?.normalized ?? []) alias.set(r.from, r.to);
      for (const r of d.query?.redirects ?? []) alias.set(r.from, r.to);
      for (const p of d.query?.pages ?? []) {
        // Find the requested topic this page came from (may have been redirected).
        const requested = batch.find((t) => t === p.title || alias.get(t) === p.title
          || alias.get(alias.get(t)) === p.title);
        if (!requested) continue;
        const ll = p.langlinks?.[0];
        if (ll) byEn.get(requested)[lang] = ll.title;
      }
      await sleep(SLEEP_MS);
    }
  }
  return byEn;
}

/**
 * Article plaintext for a list of titles in one language, truncated to
 * MAX_DOC_CHARS.
 *
 * Deliberately NOT `exintro` — Hebrew Wikipedia lead sections are short
 * enough that an intro-only fetch dropped every AI-lab and AI-researcher
 * entity page from the corpus (52 of 82 topics), which are precisely the
 * page shapes gbrain cares about. Full text truncated from the top keeps
 * those topics and still yields a lead-heavy, one-chunk-sized document.
 *
 * MediaWiki only honours `exlimit=max` together with `exintro`, so full-text
 * extracts are one request per title. Sequential with a delay; the corpus is
 * built once and committed.
 */
async function fetchExtracts(lang, titles) {
  const out = new Map();
  for (const title of titles) {
    if (out.has(title)) continue;
    const d = await api(lang, {
      action: 'query', redirects: '1', prop: 'extracts|revisions',
      explaintext: '1', exlimit: '1', rvprop: 'ids', titles: title,
    });
    for (const p of d.query?.pages ?? []) {
      if (p.missing || !p.extract) continue;
      const entry = {
        title: p.title,
        pageid: p.pageid,
        revid: p.revisions?.[0]?.revid ?? null,
        text: p.extract.replace(/\s+\n/g, '\n').trim().slice(0, MAX_DOC_CHARS),
      };
      out.set(p.title, entry);
      out.set(title, entry);   // requested name may differ (redirect/normalize)
    }
    await sleep(FULLTEXT_SLEEP_MS);
  }
  return out;
}

/** Real redirect titles pointing at each article, per language. */
async function fetchRedirects(lang, titles) {
  const out = new Map();
  for (const batch of chunk(titles, BATCH)) {
    const d = await api(lang, {
      action: 'query', prop: 'redirects', rdlimit: 'max', rdnamespace: '0',
      titles: batch.join('|'),
    });
    for (const p of d.query?.pages ?? []) {
      if (p.missing) continue;
      out.set(p.title, (p.redirects ?? []).map((r) => r.title));
    }
    for (const r of d.query?.normalized ?? []) {
      if (out.has(r.to)) out.set(r.from, out.get(r.to));
    }
    await sleep(SLEEP_MS);
  }
  return out;
}

const normTitle = (s) => s.toLowerCase().replace(/\s*\([^)]*\)\s*$/, '').replace(/[\s_\-–—'’"״׳ـ]/g, '');

/**
 * Reject aliases that are not a clean retrieval test.
 *
 * The `otherTitles` guard is the important one. zh.wikipedia redirects
 * "Claude 2" to the Anthropic article, but this corpus ALSO contains a
 * separate Claude (AI) document — so that query has two defensible gold
 * answers while the qrel names only one. Keeping it would penalise a model
 * for retrieving the arguably-better doc. Ambiguous labels are dropped, not
 * guessed at.
 */
function keepAlias(alias, articleTitle, otherTitles) {
  const a = normTitle(alias);
  if (a.length < 2) return false;
  if (/^\d+$/.test(alias)) return false;
  if (a === normTitle(articleTitle)) return false;   // identical to its own title
  for (const other of otherTitles) {
    const o = normTitle(other);
    if (o.length < 2) continue;
    // Alias collides with, or is a superstring of, a DIFFERENT doc's title.
    if (a === o || a.startsWith(o) || o.startsWith(a)) return false;
  }
  return true;
}

/**
 * Majority script of a string, ignoring digits/punctuation/whitespace.
 * Used to report what fraction of each slice's alias queries are actually
 * written in the slice's script — a Hebrew slice whose queries are all Latin
 * brand names would not support any claim about Hebrew.
 */
export function detectScript(s) {
  const counts = { hebrew: 0, arabic: 0, cyrillic: 0, han: 0, kana: 0, latin: 0, other: 0 };
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (/[\s\d\p{P}\p{S}]/u.test(ch)) continue;
    if ((c >= 0x0590 && c <= 0x05ff) || (c >= 0xfb1d && c <= 0xfb4f)) counts.hebrew++;
    // Arabic + Arabic Supplement/Extended + presentation forms A/B.
    else if ((c >= 0x0600 && c <= 0x06ff) || (c >= 0x0750 && c <= 0x077f)
             || (c >= 0x08a0 && c <= 0x08ff) || (c >= 0xfb50 && c <= 0xfdff)
             || (c >= 0xfe70 && c <= 0xfeff)) counts.arabic++;
    // Cyrillic + Cyrillic Supplement/Extended-A/B.
    else if ((c >= 0x0400 && c <= 0x052f) || (c >= 0x2de0 && c <= 0x2dff)
             || (c >= 0xa640 && c <= 0xa69f)) counts.cyrillic++;
    else if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf)
             || (c >= 0xf900 && c <= 0xfaff)) counts.han++;
    else if ((c >= 0x3040 && c <= 0x30ff) || (c >= 0x31f0 && c <= 0x31ff)) counts.kana++;
    else if (/[a-zA-ZÀ-ɏ]/.test(ch)) counts.latin++;
    else counts.other++;
  }
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  if (total === 0) return 'none';
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

/** Which script counts as "in-language" for a given wiki. */
const IN_SCRIPT = {
  en: ['latin'], he: ['hebrew'], ar: ['arabic'], ru: ['cyrillic'],
  zh: ['han'], ja: ['han', 'kana'],
};

/**
 * Raw Wikipedia responses are cached so re-deriving the corpus (changing a
 * filter, adding a stat) doesn't re-hit the API for ~350 requests. Cache is
 * gitignored; the COMMITTED artefacts are corpus/*.jsonl + manifest.json,
 * which carry pageid + revid, so the exact revisions stay attributable
 * whether or not the cache survives. `--refetch` bypasses it.
 */
const CACHE_PATH = join(__dirname, '.fetch-cache.json');
/** Langlinks are cached SEPARATELY from extracts so `--probe` (cheap: ~1 request
 *  per 20 topics per language) can size the pool without the ~1,200-request
 *  extract pass, and so the extract pass reuses the probe's work. */
const TITLE_CACHE_PATH = join(__dirname, '.title-cache.json');

async function resolveTitlesCached(topics) {
  if (!process.argv.includes('--refetch') && existsSync(TITLE_CACHE_PATH)) {
    const c = JSON.parse(readFileSync(TITLE_CACHE_PATH, 'utf8'));
    if (c.langs?.join() === LANGS.join() && c.topics_count === topics.length) {
      process.stderr.write(`using cached langlinks from ${c.fetched_at} (--refetch to bypass)\n`);
      return new Map(c.titleMap);
    }
  }
  const titleMap = await resolveTitles(topics);
  writeFileSync(TITLE_CACHE_PATH, JSON.stringify({
    fetched_at: new Date().toISOString(), langs: LANGS,
    topics_count: topics.length, titleMap: [...titleMap],
  }));
  return titleMap;
}

async function fetchAll(topics) {
  if (!process.argv.includes('--refetch')) {
    try {
      const c = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
      if (c.langs?.join() !== LANGS.join() || c.topics_count !== topics.length) {
        throw new Error('cache built for a different lang/topic set');
      }
      process.stderr.write(`using cached fetches from ${c.fetched_at} (--refetch to bypass)\n`);
      return {
        titleMap: new Map(c.titleMap),
        extracts: Object.fromEntries(LANGS.map((l) => [l, new Map(c.extracts[l])])),
        redirects: Object.fromEntries(LANGS.map((l) => [l, new Map(c.redirects[l])])),
      };
    } catch { /* no cache — fetch fresh */ }
  }
  const titleMap = await resolveTitlesCached(topics);
  const withAllLangs = topics.filter((t) => LANGS.every((l) => titleMap.get(t)[l]));
  process.stderr.write(`topics present in all of ${LANGS.join('/')}: ${withAllLangs.length}\n`);

  const extracts = {}, redirects = {};
  for (const lang of LANGS) {
    const titles = withAllLangs.map((t) => titleMap.get(t)[lang]);
    extracts[lang] = await fetchExtracts(lang, titles);
    redirects[lang] = await fetchRedirects(lang, titles);
    process.stderr.write(`  ${lang}: ${extracts[lang].size} extracts, ${redirects[lang].size} redirect sets\n`);
  }
  writeFileSync(CACHE_PATH, JSON.stringify({
    fetched_at: new Date().toISOString(),
    langs: LANGS,
    topics_count: topics.length,
    titleMap: [...titleMap],
    extracts: Object.fromEntries(LANGS.map((l) => [l, [...extracts[l]]])),
    redirects: Object.fromEntries(LANGS.map((l) => [l, [...redirects[l]]])),
  }));
  return { titleMap, extracts, redirects };
}

/**
 * Slugs that COMMITTED author-written nlq queries point at. Those query files
 * are hand-written, so their gold slug must stay in the corpus or the qrel
 * dangles. They are pinned through the TARGET_DOCS cap.
 */
function pinnedSlugs() {
  const out = new Set();
  for (const lang of LANGS) {
    const p = join(__dirname, 'queries', `${lang}.nlq.jsonl`);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (line.trim()) out.add(JSON.parse(line).relevant[0]);
    }
  }
  return out;
}

/**
 * Topics the PREVIOUS build kept. Pinned so a rebuild is a superset of the last
 * corpus wherever the language intersection still allows it — otherwise a
 * re-run silently swaps half the topic set and the new numbers stop being
 * comparable to the committed receipt. To re-pick the whole set from scratch,
 * delete corpus/manifest.json first.
 */
function previouslyKept() {
  const p = join(__dirname, 'corpus', 'manifest.json');
  if (!existsSync(p)) return new Set();
  return new Set(JSON.parse(readFileSync(p, 'utf8')).topics_kept_list ?? []);
}

/**
 * Cap survivors to TARGET_DOCS.
 *
 * topics.txt is ordered by cluster, so a plain prefix cut would delete whole
 * clusters off the tail and destroy the near-neighbour density the corpus
 * exists to create. An even stride over the survivor list thins every cluster
 * proportionally instead. Deterministic, and the exact kept list is recorded in
 * the manifest either way.
 */
function selectTopics(survivors) {
  if (survivors.length <= TARGET_DOCS) return survivors;
  const pinnedSlug = pinnedSlugs();
  const pinnedTopic = previouslyKept();
  const isPinned = (t) => pinnedSlug.has(slugify(t)) || pinnedTopic.has(t);
  const rest = survivors.filter((t) => !isPinned(t));
  const need = TARGET_DOCS - (survivors.length - rest.length);
  const stride = rest.length / need;
  const picked = new Set(Array.from({ length: need }, (_, i) => rest[Math.floor(i * stride)]));
  return survivors.filter((t) => isPinned(t) || picked.has(t));
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const topics = readTopics();
  process.stderr.write(`topics in pool: ${topics.length}\n`);

  if (process.argv.includes('--probe')) {
    const titleMap = await resolveTitlesCached(topics);
    const per = Object.fromEntries(LANGS.map((l) =>
      [l, topics.filter((t) => titleMap.get(t)?.[l]).length]));
    const all = topics.filter((t) => LANGS.every((l) => titleMap.get(t)?.[l]));
    const missing = Object.fromEntries(LANGS.filter((l) => l !== 'en').map((l) =>
      [l, topics.filter((t) => !titleMap.get(t)?.[l])]));
    process.stdout.write(JSON.stringify({
      pool: topics.length, per_lang_with_article: per, present_in_all: all.length,
      missing_count: Object.fromEntries(Object.entries(missing).map(([l, m]) => [l, m.length])),
      missing,
    }, null, 2) + '\n');
    return;
  }

  const { titleMap, extracts, redirects } = await fetchAll(topics);
  const withAllLangs = topics.filter((t) => LANGS.every((l) => titleMap.get(t)?.[l]));

  // Topics with no article at all in some language — the documented coverage
  // gap. Recorded per language rather than papered over with a substitute.
  const noArticle = Object.fromEntries(LANGS.filter((l) => l !== 'en').map((l) =>
    [l, topics.filter((t) => !titleMap.get(t)?.[l])]));

  // Keep only topics whose extract clears MIN_DOC_CHARS in EVERY language.
  const survivors = withAllLangs.filter((t) =>
    LANGS.every((l) => (extracts[l].get(titleMap.get(t)[l])?.text?.length ?? 0) >= MIN_DOC_CHARS));
  const dropped = withAllLangs.filter((t) => !survivors.includes(t));
  const kept = selectTopics(survivors);
  process.stderr.write(`survived (>=${MIN_DOC_CHARS} chars in every language): ${survivors.length}\n`);
  process.stderr.write(`kept after TARGET_DOCS=${TARGET_DOCS} cap: ${kept.length}\n`);
  if (dropped.length) process.stderr.write(`dropped as too short somewhere: ${dropped.join(', ')}\n`);
  const unpinned = [...pinnedSlugs()].filter((s) => !kept.some((t) => slugify(t) === s));
  if (unpinned.length) {
    // A hand-written nlq query whose gold doc left the corpus is a dangling
    // qrel — loadSlice() would throw at eval time. Fail here instead, loudly,
    // so the nlq file gets fixed rather than the corpus quietly shipping broken.
    const msg = `committed nlq queries reference slugs no longer in the corpus: ${unpinned.join(', ')}`;
    if (!dryRun) throw new Error(msg);
    process.stderr.write(`WARNING (--dry-run): ${msg}\n`);
  }

  const summary = {};
  for (const lang of LANGS) {
    const docs = [];
    const queries = [];
    for (const topic of kept) {
      const slug = slugify(topic);
      const localTitle = titleMap.get(topic)[lang];
      const ex = extracts[lang].get(localTitle);
      docs.push({
        slug,
        lang,
        title: ex.title,
        text: ex.text,
        en_topic: topic,
        wiki_pageid: ex.pageid,
        wiki_revid: ex.revid,
        source_url: `https://${lang}.wikipedia.org/?curid=${ex.pageid}`,
        license: 'CC BY-SA 4.0',
      });
      // Every OTHER doc title in this language — the ambiguity guard needs it
      // so an alias that also names a different corpus doc is dropped.
      const otherTitles = kept
        .filter((t) => t !== topic)
        .map((t) => extracts[lang].get(titleMap.get(t)[lang])?.title)
        .filter(Boolean);
      const aliases = (redirects[lang].get(localTitle) ?? [])
        .filter((a) => keepAlias(a, ex.title, otherTitles))
        .slice(0, MAX_ALIASES_PER_TOPIC);
      for (const [i, a] of aliases.entries()) {
        const script = detectScript(a);
        queries.push({
          qid: `${lang}:alias:${slug}:${i}`,
          lang,
          family: 'alias',
          origin: 'wikipedia-redirect',   // REAL: written by wiki editors, not by us
          query: a,
          script,
          in_script: IN_SCRIPT[lang].includes(script),
          relevant: [slug],
        });
      }
    }
    // Doc-length distribution is reported because it is a real confound:
    // Hebrew articles are shorter than English ones on the same topic, so a
    // Hebrew-slice score difference is partly a document-length difference.
    // Character counts are also not comparable across scripts (a Chinese
    // character carries more information than a Latin one). See README
    // §Threats to validity.
    const lens = docs.map((d) => d.text.length).sort((a, b) => a - b);
    summary[lang] = {
      docs: docs.length,
      alias_queries: queries.length,
      alias_queries_in_script: queries.filter((q) => q.in_script).length,
      docs_with_alias_query: new Set(queries.map((q) => q.relevant[0])).size,
      doc_chars_min: lens[0],
      doc_chars_median: lens[Math.floor(lens.length / 2)],
      doc_chars_mean: Math.round(lens.reduce((s, n) => s + n, 0) / lens.length),
      doc_chars_max: lens[lens.length - 1],
    };
    if (!dryRun) {
      writeFileSync(join(__dirname, 'corpus', `${lang}.jsonl`),
        docs.map((d) => JSON.stringify(d)).join('\n') + '\n');
      writeFileSync(join(__dirname, 'queries', `${lang}.alias.jsonl`),
        queries.map((q) => JSON.stringify(q)).join('\n') + '\n');
    }
  }

  const manifest = {
    built_at: new Date().toISOString(),
    langs: LANGS,
    topic_pool: topics.length,
    topics_present_in_all_langs: withAllLangs.length,
    topics_survived_min_chars: survivors.length,
    target_docs: TARGET_DOCS,
    topics_kept: kept.length,
    topics_kept_list: kept,
    dropped: dropped,
    // Coverage gap: no article at all on that language's Wikipedia. Documented,
    // never substituted with a different topic.
    no_article: noArticle,
    cap_selection: `even stride over the ${survivors.length} survivors (previous build's kept list + nlq gold topics pinned), so every cluster thins proportionally and a rebuild stays a superset`,
    min_doc_chars: MIN_DOC_CHARS,
    max_doc_chars: MAX_DOC_CHARS,
    max_aliases_per_topic: MAX_ALIASES_PER_TOPIC,
    per_lang: summary,
    doc_source: 'Wikipedia lead-section plaintext extracts (action=query&prop=extracts&exintro&explaintext), CC BY-SA 4.0',
    alias_query_source: 'Wikipedia namespace-0 redirects (action=query&prop=redirects), CC BY-SA 4.0',
    topics_sha256: createHash('sha256').update(readFileSync(join(__dirname, 'topics.txt'))).digest('hex'),
  };
  if (!dryRun) writeFileSync(join(__dirname, 'corpus', 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ per_lang: summary, topics_kept: kept.length }, null, 2) + '\n');
}

// Only fetch when run directly, so `detectScript` can be imported (the nlq
// query files are tagged with the same detector the alias family uses).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { process.stderr.write(String(e?.stack ?? e) + '\n'); process.exit(1); });
}
