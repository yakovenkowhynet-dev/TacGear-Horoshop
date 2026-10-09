// sync.mjs — автоімпорт товарів з YML-фіду tactic-shop.in.ua у Horoshop (tacgear.com.ua) через API
//
// Логіка:
//  • Артикул = vendorCode з фіду, без змін.
//  • НОВІ товари: створюються повністю (назви, описи, категорія, фото, модифікації, характеристики).
//  • ІСНУЮЧІ товари: оновлюються ЛИШЕ ціна та статус наявності.
//  • Характеристики товарів шаблону «Одяг та взуття» мапляться на поля шаблону окремо для UA і RU.
//    Кожне значення перевіряється на відповідність мові; неправильне — перекладається,
//    порожнє поле іншої мови — заповнюється перекладом. Так само перевіряються назви та описи.
//
// ENV:
//   HOROSHOP_DOMAIN, HOROSHOP_LOGIN, HOROSHOP_PASSWORD
//   ANTHROPIC_API_KEY        — ключ для перевірки мови і перекладу (Claude)
//   DRY_RUN=1                — нічого не відправляти в Horoshop, зберегти payload у ./out
//   LIMIT=20                 — лише перші N груп товарів (тест)
//   DISCOVER=1               — показати коди характеристик і статуси наявності, які вже є на сайті
//   FEED_FILE=./feed.xml     — фід з локального файлу

import { XMLParser } from 'fast-xml-parser';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

// ============================ НАЛАШТУВАННЯ ============================
const CONFIG = {
  FEED_URL: 'https://tactic-shop.in.ua/content/export/f237fc5460703f267642a4f7ed7b0d19.xml',
  DOMAIN: process.env.HOROSHOP_DOMAIN || 'tacgear.com.ua',
  LOGIN: process.env.HOROSHOP_LOGIN,
  PASSWORD: process.env.HOROSHOP_PASSWORD,

  // Коди мов сайту (Налаштування → Мови)
  LANG_UA: 'ua',
  LANG_RU: 'ru',

  MARKUP_PERCENT: 0,
  ROUND_TO: 1,

  // Статуси наявності — точно як в адмінці. Працює лише з вимкненим обліком залишків
  PRESENCE: {
    inStock: 'В наявності',
    onOrder: 'Під замовлення',
    outOfStock: 'Немає в наявності',
  },
  IN_STOCK_FLAG_AS: 'onOrder', // для available="" + in_stock="true"

  // Категорія фіду → розділ сайту: число (ID розділу) або шлях "Розділ / Підрозділ"
  CATEGORY_MAP: {},
  EXCLUDE_CATEGORIES: [],

  // ---------- Шаблон даних «Одяг та взуття» ----------
  // Категорії фіду (разом із підкатегоріями), товари яких належать до цього шаблону.
  // 1061 = «Одяг та взуття», 1549 = «Жіночий одяг»
  TEMPLATE_CATEGORIES: ['1061', '1549'],

  // param фіду → поле шаблону.
  //   code  — код (ключ) характеристики з шаблону «Одяг та взуття»  ← ЗАПОВНИТИ
  //   multi — true, якщо поле в шаблоні «мультивибір» (значення через " ; ")
  // Поки code = null, характеристика не передається.
  PARAM_MAP: {
    'Цвет':                 { code: null, multi: true  }, // Колір
    'Размер':               { code: null, multi: false }, // Розмір
    'Тип материала':        { code: null, multi: false }, // Матеріал
    'Страна производитель': { code: null, multi: false }, // Країна-виробник
    'Вид изделия':          { code: null, multi: false }, // Вид виробу
    'Узоры и принты':       { code: null, multi: false }, // Візерунок / принт
    'Тип':                  { code: null, multi: false }, // Тип
    'Назначение':           { code: null, multi: false }, // Призначення
  },
  VARIANT_PARAMS: ['Размер', 'Цвет'],

  // Товари, які були у фіді минулого запуску, а тепер зникли
  MISSING_ACTION: 'outOfStock', // 'outOfStock' | 'hide' | 'none'

  // ---------- Перевірка мови / переклад ----------
  TRANSLATE: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: 'claude-haiku-5-5',
    checkTitles: true,
    checkDescriptions: true,
    shortBatch: 50,      // назв / значень характеристик за запит
    htmlBatchChars: 14000,
  },

  STATE_DIR: 'state',    // кеш перекладів і список артикулів попереднього фіду
  MAX_IMAGES: 15,
  BATCH_NEW: 20,
  BATCH_UPDATE: 200,
  MAX_BATCH_BYTES: 300_000,
  PAUSE_MS: 1000,

  DRY_RUN: process.env.DRY_RUN === '1',
  DISCOVER: process.env.DISCOVER === '1',
  LIMIT: Number(process.env.LIMIT || 0),
  FEED_FILE: process.env.FEED_FILE,
};
// =====================================================================

const UA = CONFIG.LANG_UA, RU = CONFIG.LANG_RU;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const txt = (v) => (v == null ? '' : typeof v === 'object' ? String(v['#text'] ?? '') : String(v));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sha = (o) => crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex').slice(0, 16);

async function readJson(path, fallback) {
  try { return JSON.parse(await fs.readFile(path, 'utf8')); } catch { return fallback; }
}

// ============================ Визначення мови ============================
const UA_RE = /[іїєґІЇЄҐ]/g, RU_RE = /[ыэёъЫЭЁЪ]/g, CYR_RE = /[а-яА-ЯіїєґІЇЄҐёЁ]/;
function detectLang(s = '') {
  const t = s.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ');
  if (!CYR_RE.test(t)) return 'neutral';           // латиниця, цифри, розміри
  const u = (t.match(UA_RE) || []).length, r = (t.match(RU_RE) || []).length;
  if (!u && !r) return 'unknown';                  // кирилиця без маркерів («Хаки», «Футболка олива»)
  if (u > r * 2) return 'ua';
  if (r > u * 2) return 'ru';
  return 'mixed';
}

// ============================ Перекладач ============================
class Translator {
  constructor(cache) { this.cache = cache; this.pending = new Map(); this.stats = { local: 0, cached: 0, api: 0, failed: 0 }; this.errors = []; }

  // Пара полів UA/RU. Повертає ключ результату.
  pair(ua, ru, html = false) {
    ua = (ua || '').trim(); ru = (ru || '').trim();
    if (!ua && !ru) return this.local({ ua: '', ru: '' });
    const dUa = detectLang(ua), dRu = detectLang(ru);
    const okUa = ua && (dUa === 'ua' || dUa === 'neutral' || (html && dUa === 'unknown'));
    const okRu = ru && (dRu === 'ru' || dRu === 'neutral' || (html && dRu === 'unknown'));
    if (okUa && okRu) return this.local({ ua, ru });
    if (!this.enabled(html)) return this.local({ ua: ua || ru, ru: ru || ua });
    return this.enqueue({ type: 'pair', html, ua, ru });
  }

  // Набір значень характеристики у змішаних мовах → [{ua, ru}]
  values(values) {
    const uniq = [...new Set(values.map((v) => v.trim()).filter(Boolean))];
    if (!uniq.length) return this.local([]);
    if (uniq.every((v) => detectLang(v) === 'neutral')) return this.local(uniq.map((v) => ({ ua: v, ru: v })));
    if (!this.enabled(false)) return this.local(uniq.map((v) => ({ ua: v, ru: v })));
    return this.enqueue({ type: 'values', values: uniq });
  }

  enabled(html) {
    if (!CONFIG.TRANSLATE.apiKey) return false;
    return html ? CONFIG.TRANSLATE.checkDescriptions : true;
  }
  local(result) { const k = 'L' + sha(result); this.cache[k] = result; this.stats.local++; return k; }
  enqueue(task) {
    const k = sha(task);
    if (this.cache[k]) { this.stats.cached++; return k; }
    this.pending.set(k, task);
    return k;
  }
  get(k) { return this.cache[k]; }

  async flush() {
    const tasks = [...this.pending.entries()].map(([id, t]) => ({ id, ...t }));
    if (!tasks.length) return;
    const short = tasks.filter((t) => !t.html), html = tasks.filter((t) => t.html);
    const batches = [];
    for (let i = 0; i < short.length; i += CONFIG.TRANSLATE.shortBatch) batches.push(short.slice(i, i + CONFIG.TRANSLATE.shortBatch));
    let cur = [], size = 0;
    for (const t of html) {
      const s = t.ua.length + t.ru.length;
      if (cur.length && size + s > CONFIG.TRANSLATE.htmlBatchChars) { batches.push(cur); cur = []; size = 0; }
      cur.push(t); size += s;
    }
    if (cur.length) batches.push(cur);

    log(`Переклад / перевірка мови: ${tasks.length} завдань, ${batches.length} запитів до Claude`);
    for (const [i, batch] of batches.entries()) {
      try {
        const out = await this.callClaude(batch);
        for (const t of batch) {
          const r = out.get(t.id);
          if (r) { this.cache[t.id] = r; this.stats.api++; }
          else this.fail(t, 'немає у відповіді');
        }
      } catch (e) {
        batch.forEach((t) => this.fail(t, e.message));
      }
      if ((i + 1) % 10 === 0) log(`   переклад: ${i + 1}/${batches.length}`);
    }
    this.pending.clear();
  }

  fail(t, reason) {
    this.stats.failed++;
    this.errors.push({ task: t.type, sample: (t.ua || t.values?.join(' | ') || '').slice(0, 80), reason });
    // Фолбек: не блокуємо імпорт, беремо як є (і не кешуємо — наступного разу спробуємо знову)
    this.cache[t.id] = t.type === 'pair' ? { ua: t.ua || t.ru, ru: t.ru || t.ua } : t.values.map((v) => ({ ua: v, ru: v }));
    this.cache[t.id].__fallback = true;
  }

  async callClaude(batch, attempt = 1) {
    const system = `You are a catalog editor for a Ukrainian online store of tactical and outdoor gear. The site is bilingual: "ua" = Ukrainian, "ru" = Russian.
You receive a JSON array of tasks.
- type "pair": "ua" and "ru" must contain the same text in Ukrainian and Russian. Check each field. If a field is already in the correct language, return it UNCHANGED. If it is in the wrong language or empty, replace it with a translation of the other field into the correct language.
- type "values": characteristic values in mixed languages; the list may contain the same value in both languages (e.g. "Сірий", "Серый"). Return the distinct meanings in original order, each as {"ua": ..., "ru": ...}, merging a value with its translation.
Rules: never translate brand names, model names, Latin codes, sizes, units or numbers. For HTML keep every tag and attribute exactly, translate only the text. Use standard Ukrainian/Russian terminology for military and tactical gear (плитоноска, підсумок/подсумок, мультикам, піксель/пиксель, койот, олива). Capitalize values as in the source.
Return ONLY a JSON array, no prose, no markdown:
[{"id":"...","ua":"...","ru":"..."}] for pair tasks and [{"id":"...","items":[{"ua":"...","ru":"..."}]}] for values tasks.`;
    const payload = batch.map((t) => (t.type === 'pair' ? { id: t.id, type: 'pair', ua: t.ua, ru: t.ru } : { id: t.id, type: 'values', values: t.values }));
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': CONFIG.TRANSLATE.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: CONFIG.TRANSLATE.model, max_tokens: 16000, system, messages: [{ role: 'user', content: JSON.stringify(payload) }] }),
    });
    if (!res.ok) {
      if (attempt <= 3 && [429, 500, 502, 503, 529].includes(res.status)) { await sleep(5000 * attempt); return this.callClaude(batch, attempt + 1); }
      throw new Error(`Claude API HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const data = await res.json();
    const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').replace(/```json|```/g, '').trim();
    let arr;
    try { arr = JSON.parse(text); } catch {
      if (attempt <= 2) return this.callClaude(batch, attempt + 1);
      throw new Error('Claude повернув не-JSON');
    }
    const map = new Map();
    for (const r of arr) {
      const t = batch.find((b) => b.id === r.id);
      if (!t) continue;
      if (t.type === 'pair' && typeof r.ua === 'string' && typeof r.ru === 'string') map.set(r.id, { ua: r.ua.trim(), ru: r.ru.trim() });
      if (t.type === 'values' && Array.isArray(r.items)) map.set(r.id, r.items.filter((x) => x?.ua && x?.ru).map((x) => ({ ua: x.ua.trim(), ru: x.ru.trim() })));
    }
    return map;
  }
}

// ============================ Фід ============================
async function loadFeed() {
  let xml;
  if (CONFIG.FEED_FILE) xml = await fs.readFile(CONFIG.FEED_FILE, 'utf8');
  else {
    const res = await fetch(CONFIG.FEED_URL);
    if (!res.ok) throw new Error(`Фід недоступний: HTTP ${res.status}`);
    xml = await res.text();
  }
  const parser = new XMLParser({
    ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text',
    parseTagValue: false, parseAttributeValue: false, trimValues: true,
    isArray: (n) => ['category', 'offer', 'picture', 'param'].includes(n),
  });
  const shop = parser.parse(xml)?.yml_catalog?.shop;
  if (!shop?.offers?.offer?.length) throw new Error('У фіді не знайдено товарів — імпорт зупинено');
  return shop;
}

function buildCategories(shop) {
  const cats = new Map();
  for (const c of shop.categories?.category ?? []) {
    cats.set(String(c['@_id']), { name: txt(c).trim().replace(/\s*\/\s*/g, ' - '), parentId: c['@_parentId'] ? String(c['@_parentId']) : null });
  }
  const chain = (id) => {
    const out = []; let cur = String(id), guard = 0;
    while (cur && cats.has(cur) && guard++ < 15) { out.unshift(cur); cur = cats.get(cur).parentId; }
    return out;
  };
  const excluded = new Set(CONFIG.EXCLUDE_CATEGORIES.map(String));
  const tpl = new Set(CONFIG.TEMPLATE_CATEGORIES.map(String));
  return {
    isExcluded: (id) => chain(id).some((c) => excluded.has(c)),
    inTemplate: (id) => chain(id).some((c) => tpl.has(c)),
    parentFor: (id) => {
      const m = CONFIG.CATEGORY_MAP[String(id)];
      if (typeof m === 'number') return { id: m };
      if (m) return m;
      return chain(id).map((c) => cats.get(c).name).join(' / ');
    },
  };
}

function cleanHtml(html = '') {
  return html
    .replace(/<\/?article[^>]*>/gi, '')
    .replace(/\s(data-[\w-]+|dir)="[^"]*"/gi, '')
    .replace(/<a\s[^>]*href="[^"]*tactic-shop[^"]*"[^>]*>([\s\S]*?)<\/a>/gi, '$1')
    .replace(/<p>(\s|&nbsp;)*<\/p>/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function paramsOf(o) {
  const m = {};
  for (const p of o.param ?? []) {
    const k = String(p['@_name'] ?? '').trim(), v = txt(p).trim();
    if (k && v) (m[k] ??= []).push(v);
  }
  return m;
}

function priceOf(raw) {
  const p = Number(String(raw).replace(',', '.'));
  if (!Number.isFinite(p) || p <= 0) return null;
  return Math.round((p * (1 + CONFIG.MARKUP_PERCENT / 100)) / CONFIG.ROUND_TO) * CONFIG.ROUND_TO;
}

function presenceOf(o) {
  if (o['@_available'] === 'true') return CONFIG.PRESENCE.inStock;
  if (o['@_in_stock'] === 'true') return CONFIG.PRESENCE[CONFIG.IN_STOCK_FLAG_AS];
  return CONFIG.PRESENCE.outOfStock;
}

const langObj = (ua, ru) => (ua === ru ? ua : { [UA]: ua, [RU]: ru });

// ============================ Horoshop API ============================
let token = null;
async function call(path, body, attempt = 1) {
  const res = await fetch(`https://${CONFIG.DOMAIN}/api/${path}/`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(path === 'auth' ? body : { ...body, token }),
  });
  let json;
  try { json = await res.json(); } catch { json = { status: 'ERROR', response: { message: `HTTP ${res.status}` } }; }
  if (['OK', 'WARNING'].includes(json.status)) return json;
  if (path !== 'auth' && attempt <= 3) {
    log(`⚠️ ${path}: ${json.status} ${JSON.stringify(json.response ?? '').slice(0, 200)} — повтор ${attempt}`);
    await sleep(3000 * attempt);
    if (json.status === 'UNAUTHORIZED' || res.status === 401) await auth();
    return call(path, body, attempt + 1);
  }
  throw new Error(`${path}: ${json.status} ${JSON.stringify(json.response ?? '').slice(0, 500)}`);
}
async function auth() {
  if (!CONFIG.LOGIN || !CONFIG.PASSWORD) throw new Error('Не задано HOROSHOP_LOGIN / HOROSHOP_PASSWORD');
  const r = await call('auth', { login: CONFIG.LOGIN, password: CONFIG.PASSWORD });
  token = r.response?.token;
  if (!token) throw new Error('Авторизація не повернула token');
}
async function exportAll(includedParams) {
  const all = [];
  for (let offset = 0; ; offset += 500) {
    const r = await call('catalog/export', { offset, limit: 500, ...(includedParams ? { includedParams } : {}) });
    const items = r.response?.products ?? [];
    all.push(...items);
    if (items.length < 500) break;
  }
  return all;
}

// DISCOVER: які коди характеристик і статуси наявності вже використовуються на сайті
async function discover() {
  await auth();
  const r = await call('catalog/export', { offset: 0, limit: 500 });
  const products = r.response?.products ?? [];
  const chars = new Map(), presence = new Set();
  for (const p of products) {
    if (p.presence) presence.add(typeof p.presence === 'object' ? JSON.stringify(p.presence) : p.presence);
    for (const [k, v] of Object.entries(p.characteristics ?? {})) {
      if (!chars.has(k)) chars.set(k, JSON.stringify(v).slice(0, 80));
    }
  }
  console.log(`\nПроаналізовано товарів: ${products.length}`);
  console.log('\nКоди характеристик (код → приклад значення):');
  for (const [k, v] of chars) console.log(`  ${k.padEnd(30)} ${v}`);
  console.log('\nСтатуси наявності на сайті:', [...presence].join(' | ') || '—');
  if (!chars.size) console.log('\nХарактеристик не знайдено. Створіть 1 тестовий товар у шаблоні «Одяг та взуття», заповніть усі поля і запустіть DISCOVER ще раз.');
}

// ============================ Пачки імпорту ============================
function chunk(items, maxCount) {
  const out = []; let cur = [], size = 0;
  for (const it of items) {
    const s = JSON.stringify(it).length;
    if (cur.length && (cur.length >= maxCount || size + s > CONFIG.MAX_BATCH_BYTES)) { out.push(cur); cur = []; size = 0; }
    cur.push(it); size += s;
  }
  if (cur.length) out.push(cur);
  return out;
}
const OK_CODES = new Set([0, 3, 4, 9, 15, 22, 28]);
async function send(label, items, batchSize, report) {
  if (!items.length) return;
  const batches = chunk(items, batchSize);
  log(`${label}: ${items.length} товарів, ${batches.length} запитів`);
  for (const [i, batch] of batches.entries()) {
    if (CONFIG.DRY_RUN) {
      await fs.writeFile(`out/${label}-${String(i + 1).padStart(3, '0')}.json`, JSON.stringify({ products: batch }, null, 2));
      continue;
    }
    try {
      const r = await call('catalog/import', { products: batch });
      for (const rec of r.response?.log ?? []) for (const info of rec.info ?? []) {
        if (!OK_CODES.has(info.code)) report.importErrors.push({ article: rec.article, code: info.code, message: info.message });
      }
      report.sent += batch.length;
    } catch (e) {
      report.failedBatches.push({ label, index: i + 1, error: e.message, articles: batch.map((p) => p.article) });
      log(`❌ ${label} пачка ${i + 1}: ${e.message}`);
    }
    if ((i + 1) % 10 === 0) log(`   ${label}: ${i + 1}/${batches.length}`);
    await sleep(CONFIG.PAUSE_MS);
  }
}

// ============================ Головний сценарій ============================
async function main() {
  const started = Date.now();
  await fs.mkdir('out', { recursive: true });
  await fs.mkdir(CONFIG.STATE_DIR, { recursive: true });
  if (CONFIG.DISCOVER) return discover();

  const unmapped = Object.entries(CONFIG.PARAM_MAP).filter(([, v]) => !v.code).map(([k]) => k);
  if (unmapped.length) log(`ℹ️ Без коду в шаблоні (не передаються): ${unmapped.join(', ')}`);
  if (!CONFIG.TRANSLATE.apiKey) log('⚠️ ANTHROPIC_API_KEY не задано — мову не перевіряємо, поля копіюються як є');

  const report = { sent: 0, importErrors: [], failedBatches: [], duplicates: [], noArticle: [] };

  log('Завантажую фід…');
  const shop = await loadFeed();
  const cats = buildCategories(shop);
  const offers = shop.offers.offer.filter((o) => !cats.isExcluded(txt(o.categoryId)));

  // --- Артикули = vendorCode без змін; дублікати і порожні — у звіт ---
  const seen = new Map();
  const valid = [];
  for (const o of offers) {
    const a = txt(o.vendorCode).trim();
    if (!a) { report.noArticle.push(o['@_id']); continue; }
    if (seen.has(a)) { report.duplicates.push({ article: a, offerIds: [seen.get(a), o['@_id']] }); continue; }
    seen.set(a, o['@_id']); valid.push(o);
  }

  // --- Групи модифікацій ---
  const groups = new Map();
  for (const o of valid) {
    const g = String(o['@_group_id'] || `single-${o['@_id']}`);
    (groups.get(g) ?? groups.set(g, []).get(g)).push(o);
  }
  let groupList = [...groups.values()];
  if (CONFIG.LIMIT) groupList = groupList.slice(0, CONFIG.LIMIT);

  // --- Що вже є на сайті ---
  let existing = new Set();
  if (!CONFIG.DRY_RUN) {
    await auth();
    existing = new Set((await exportAll(['article'])).map((p) => String(p.article ?? '')).filter(Boolean));
    log(`На сайті вже є товарів: ${existing.size}`);
  }

  const cache = await readJson(`${CONFIG.STATE_DIR}/translations.json`, {});
  const tr = new Translator(cache);

  // --- Фаза 1: сирі дані + завдання на перевірку мови (лише для нових товарів) ---
  const rows = [];
  for (const members of groupList) {
    members.sort((a, b) => Number(a['@_id']) - Number(b['@_id']));
    const parentArticle = txt(members[0].vendorCode).trim();
    const catId = txt(members[0].categoryId);
    const inTpl = cats.inTemplate(catId);

    for (const o of members) {
      const article = txt(o.vendorCode).trim();
      const price = priceOf(txt(o.price));
      if (price == null) continue;
      const row = { o, article, parentArticle, catId, inTpl, multi: members.length > 1, price, presence: presenceOf(o), isNew: !existing.has(article) };
      if (row.isNew) {
        const params = paramsOf(o);
        row.k = {
          title: tr.pair(txt(o.name_ua), txt(o.name)),
          desc: tr.pair(cleanHtml(txt(o.description_ua)), cleanHtml(txt(o.description)), true),
          params: {},
        };
        const needed = new Set([...(inTpl ? Object.keys(CONFIG.PARAM_MAP).filter((p) => CONFIG.PARAM_MAP[p].code) : []), ...(row.multi ? CONFIG.VARIANT_PARAMS : [])]);
        for (const p of needed) if (params[p]) row.k.params[p] = tr.values(params[p]);
      }
      rows.push(row);
    }
  }

  // --- Фаза 2: переклад ---
  if (CONFIG.DRY_RUN) await fs.writeFile('out/translation-tasks.json', JSON.stringify([...tr.pending.values()], null, 2));
  await tr.flush();
  const persist = Object.fromEntries(Object.entries(cache).filter(([k, v]) => !k.startsWith('L') && !v.__fallback));
  await fs.writeFile(`${CONFIG.STATE_DIR}/translations.json`, JSON.stringify(persist));

  // --- Фаза 3: payload ---
  const newOnes = [], updates = [];
  for (const r of rows) {
    if (!r.isNew) { updates.push({ article: r.article, price: r.price, presence: r.presence }); continue; }
    const o = r.o;
    const title = tr.get(r.k.title), desc = tr.get(r.k.desc);
    const p = {
      article: r.article,
      parent_article: r.parentArticle,
      title: { [UA]: title.ua, [RU]: title.ru },
      parent: cats.parentFor(r.catId),
      price: r.price,
      currency: txt(o.currencyId) || 'UAH',
      presence: r.presence,
      display_in_showcase: true,
    };
    if (desc.ua || desc.ru) p.description = { [UA]: desc.ua, [RU]: desc.ru };
    const vendor = txt(o.vendor).trim();
    if (vendor && vendor.toLowerCase() !== 'no brand') p.brand = vendor;

    if (r.multi) {
      const vp = CONFIG.VARIANT_PARAMS.find((x) => r.k.params[x] && tr.get(r.k.params[x])?.length);
      if (vp) { const v = tr.get(r.k.params[vp])[0]; p.mod_title = { [UA]: v.ua, [RU]: v.ru }; }
    }

    if (r.inTpl) {
      const ch = {};
      for (const [feedName, { code, multi }] of Object.entries(CONFIG.PARAM_MAP)) {
        if (!code || !r.k.params[feedName]) continue;
        const items = tr.get(r.k.params[feedName]) ?? [];
        if (!items.length) continue;
        const use = multi ? items : items.slice(0, 1);
        ch[code] = langObj(use.map((i) => i.ua).join(' ; '), use.map((i) => i.ru).join(' ; '));
      }
      if (Object.keys(ch).length) p.characteristics = ch;
    }

    const pics = (o.picture ?? []).map(txt).filter(Boolean).slice(0, CONFIG.MAX_IMAGES);
    if (pics.length) p.images = { override: true, links: pics };
    newOnes.push(p);
  }
  // батьки перед варіантами
  newOnes.sort((a, b) => (a.article === a.parent_article ? 0 : 1) - (b.article === b.parent_article ? 0 : 1));

  // --- Зниклі з фіду (порівняння з попереднім запуском) ---
  const feedArticles = [...seen.keys()];
  const prev = await readJson(`${CONFIG.STATE_DIR}/feed-articles.json`, []);
  const missing = (CONFIG.MISSING_ACTION === 'none' || CONFIG.LIMIT) ? [] :
    prev.filter((a) => !seen.has(a) && (CONFIG.DRY_RUN || existing.has(a)))
      .map((article) => (CONFIG.MISSING_ACTION === 'hide'
        ? { article, presence: CONFIG.PRESENCE.outOfStock, display_in_showcase: false }
        : { article, presence: CONFIG.PRESENCE.outOfStock }));

  await send('new', newOnes, CONFIG.BATCH_NEW, report);
  await send('update', updates, CONFIG.BATCH_UPDATE, report);
  await send('missing', missing, CONFIG.BATCH_UPDATE, report);

  if (!CONFIG.LIMIT && !CONFIG.DRY_RUN && !report.failedBatches.length) {
    await fs.writeFile(`${CONFIG.STATE_DIR}/feed-articles.json`, JSON.stringify(feedArticles));
  }

  const summary = {
    date: new Date().toISOString(), dryRun: CONFIG.DRY_RUN,
    inFeed: rows.length, created: newOnes.length, updatedPriceAndStock: updates.length, missingFromFeed: missing.length,
    duplicates: report.duplicates.length, noArticle: report.noArticle.length,
    translation: tr.stats, importErrors: report.importErrors.length, failedBatches: report.failedBatches.length,
    minutes: ((Date.now() - started) / 60000).toFixed(1),
  };
  await fs.writeFile('out/report.json', JSON.stringify({ summary, ...report, translationErrors: tr.errors }, null, 2));
  log('Готово:', JSON.stringify(summary));
  if (report.failedBatches.length) process.exitCode = 1;
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
