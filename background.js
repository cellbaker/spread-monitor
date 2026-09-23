// Service worker: тянет тикеры с 9 бирж, считает спред (last - fair) / fair * 100,
// складывает в chrome.storage.local. Polling каждые POLL_MS мс.
//
// Авто-открытие вкладок по сигналам вынесено в alerts.js и подключается ОПЦИОНАЛЬНО.
// В публичную сборку alerts.js не кладётся (см. make-public.ps1): без него расширение
// работает как обычный монитор спреда — считает и показывает, но вкладок не открывает.
let alertsMod = null;
async function loadAlertsModule() {
  try { alertsMod = await import('./alerts.js'); }
  catch { alertsMod = null; } // файла нет — публичная сборка, это штатная ситуация
  // Попап по этому флагу прячет тумблер, чтобы в публичной версии не было мёртвой кнопки.
  chrome.storage.local.set({ autoOpenAvailable: !!alertsMod });
}
//
// Нормализованный symbol = "BTC/USDT". Каждый адаптер должен вернуть массив
// { symbol, last, fair }.

// 200мс (5 опросов/с) душили тяжёлые эндпоинты: Gate отдаёт ~350КБ, мы тянули с него
// ~8МБ/мин, он начинал троттлить, и запросы обрывались по таймауту («user aborted»).
// 1.2с — виджет всё ещё живой, а биржи успевают отвечать.
const POLL_MS = 1200;
const FETCH_TIMEOUT_MS = 15000; // Gate под нагрузкой отвечает дольше 10с

async function safeFetch(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal, cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

const num = (x) => {
  const n = parseFloat(x);
  return isFinite(n) ? n : NaN;
};

// ---------- адаптеры ----------

async function fetchMexc() {
  const j = await safeFetch('https://contract.mexc.com/api/v1/contract/ticker');
  if (!Array.isArray(j?.data)) throw new Error('MEXC bad response');
  return j.data
    .map((t) => ({ symbol: t.symbol.replace('_', '/'), last: num(t.lastPrice), fair: num(t.fairPrice) }))
    .filter((x) => isFinite(x.last) && isFinite(x.fair) && x.fair > 0);
}

async function fetchOurbit() {
  const j = await safeFetch('https://futures.ourbit.com/api/v1/contract/ticker');
  if (!Array.isArray(j?.data)) throw new Error('Ourbit bad response');
  return j.data
    .map((t) => ({ symbol: t.symbol.replace('_', '/'), last: num(t.lastPrice), fair: num(t.fairPrice) }))
    .filter((x) => isFinite(x.last) && isFinite(x.fair) && x.fair > 0);
}

function splitQuote(s, quotes = ['USDT', 'USDC', 'USD', 'BTC', 'ETH']) {
  for (const q of quotes) if (s.endsWith(q)) return [s.slice(0, -q.length), q];
  return [s, ''];
}

async function fetchBybit() {
  const j = await safeFetch('https://api.bybit.com/v5/market/tickers?category=linear');
  if (j?.retCode !== 0 || !Array.isArray(j?.result?.list)) throw new Error('Bybit bad response');
  return j.result.list
    .map((t) => {
      const [b, q] = splitQuote(t.symbol);
      return { symbol: b + '/' + q, last: num(t.lastPrice), fair: num(t.markPrice) };
    })
    .filter((x) => isFinite(x.last) && isFinite(x.fair) && x.fair > 0);
}

async function fetchBinanceLike(baseUrl) {
  // Binance USDⓈ-M и совместимые (Aster). Mark + last — два эндпоинта.
  const [marks, prices] = await Promise.all([
    safeFetch(`${baseUrl}/fapi/v1/premiumIndex`),
    safeFetch(`${baseUrl}/fapi/v1/ticker/price`),
  ]);
  if (!Array.isArray(marks) || !Array.isArray(prices)) throw new Error('binance-like bad response');
  const lastBySym = {};
  for (const p of prices) lastBySym[p.symbol] = num(p.price);
  return marks
    .map((m) => {
      const [b, q] = splitQuote(m.symbol);
      return { symbol: b + '/' + q, last: lastBySym[m.symbol], fair: num(m.markPrice) };
    })
    .filter((x) => isFinite(x.last) && isFinite(x.fair) && x.fair > 0);
}

const fetchBinance = () => fetchBinanceLike('https://fapi.binance.com');
const fetchAster = () => fetchBinanceLike('https://fapi.asterdex.com');

// OKX: last и mark лежат в разных эндпоинтах, объединяем по instId (BTC-USDT-SWAP → BTC/USDT).
// Берём только USDT-своп: инверсные BTC-USD-SWAP считаются в монете и ломают сравнение.
async function fetchOkx() {
  const [tick, mark] = await Promise.all([
    safeFetch('https://www.okx.com/api/v5/market/tickers?instType=SWAP'),
    safeFetch('https://www.okx.com/api/v5/public/mark-price?instType=SWAP'),
  ]);
  const marks = {};
  for (const m of mark?.data || []) marks[m.instId] = num(m.markPx);
  const out = [];
  for (const t of tick?.data || []) {
    if (!String(t.instId).endsWith('-USDT-SWAP')) continue;
    const base = String(t.instId).replace('-USDT-SWAP', '');
    const last = num(t.last);
    const fair = marks[t.instId];
    if (isFinite(last) && isFinite(fair) && fair > 0) out.push({ symbol: base + '/USDT', last, fair });
  }
  return out;
}

async function fetchGate() {
  const j = await safeFetch('https://api.gateio.ws/api/v4/futures/usdt/tickers');
  if (!Array.isArray(j)) throw new Error('Gate bad response');
  return j
    .map((t) => ({ symbol: t.contract.replace('_', '/'), last: num(t.last), fair: num(t.mark_price) }))
    .filter((x) => isFinite(x.last) && isFinite(x.fair) && x.fair > 0);
}

async function fetchKucoin() {
  const j = await safeFetch('https://api-futures.kucoin.com/api/v1/contracts/active');
  if (!Array.isArray(j?.data)) throw new Error('KuCoin bad response');
  return j.data
    .map((t) => {
      // KuCoin: XBTUSDTM -> XBT/USDT (затем XBT -> BTC)
      let s = t.symbol;
      if (s.endsWith('M')) s = s.slice(0, -1);
      const [b0, q] = splitQuote(s);
      const b = b0 === 'XBT' ? 'BTC' : b0;
      return { symbol: b + '/' + q, last: num(t.lastTradePrice), fair: num(t.markPrice) };
    })
    .filter((x) => isFinite(x.last) && isFinite(x.fair) && x.fair > 0);
}

async function fetchBitget() {
  const j = await safeFetch('https://api.bitget.com/api/v2/mix/market/tickers?productType=usdt-futures');
  if (!Array.isArray(j?.data)) throw new Error('Bitget bad response');
  return j.data
    .map((t) => {
      const [b, q] = splitQuote(t.symbol);
      const last = num(t.lastPr ?? t.last ?? t.lastPrice);
      const fair = num(t.markPrice ?? t.indexPrice);
      return { symbol: b + '/' + q, last, fair };
    })
    .filter((x) => isFinite(x.last) && isFinite(x.fair) && x.fair > 0);
}

async function fetchBingx() {
  // У BingX премиум-индекс и тикер — раздельные эндпоинты; объединяем по символу BTC-USDT.
  const [premium, tickers] = await Promise.all([
    safeFetch('https://open-api.bingx.com/openApi/swap/v2/quote/premiumIndex'),
    safeFetch('https://open-api.bingx.com/openApi/swap/v2/quote/ticker'),
  ]);
  const marks = premium?.data || premium;
  const ts = tickers?.data || tickers;
  if (!Array.isArray(marks) || !Array.isArray(ts)) throw new Error('BingX bad response');
  const lastBySym = {};
  for (const t of ts) lastBySym[t.symbol] = num(t.lastPrice ?? t.last ?? t.close);
  return marks
    .map((m) => {
      const sym = m.symbol; // BTC-USDT
      const parts = sym.split('-');
      const symbol = parts.length === 2 ? parts[0] + '/' + parts[1] : sym;
      return { symbol, last: lastBySym[sym], fair: num(m.markPrice) };
    })
    .filter((x) => isFinite(x.last) && isFinite(x.fair) && x.fair > 0);
}

// ---------- макс. плечо (отдельные эндпоинты; меняется редко, обновляем раз в минуту) ----------

async function levMexcLike(url) {
  const j = await safeFetch(url);
  const out = {};
  for (const c of j?.data || []) {
    const lev = num(c.maxLeverage);
    if (isFinite(lev)) out[String(c.symbol).replace('_', '/')] = lev;
  }
  return out;
}
const levMexc = () => levMexcLike('https://contract.mexc.com/api/v1/contract/detail');
const levOurbit = () => levMexcLike('https://futures.ourbit.com/api/v1/contract/detail');

// ВАЖНО: instruments-info без limit отдаёт только 500 из ~810 инструментов —
// у монет из «хвоста» плечо молча терялось. limit=1000 покрывает весь список.
async function levBybit() {
  const j = await safeFetch('https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000');
  const out = {};
  for (const c of j?.result?.list || []) {
    const [b, q] = splitQuote(c.symbol);
    const lev = num(c.leverageFilter?.maxLeverage);
    if (isFinite(lev)) out[b + '/' + q] = lev;
  }
  return out;
}

async function levOkx() {
  const j = await safeFetch('https://www.okx.com/api/v5/public/instruments?instType=SWAP');
  const out = {};
  for (const c of j?.data || []) {
    if (!String(c.instId).endsWith('-USDT-SWAP')) continue;
    const lev = num(c.lever);
    if (isFinite(lev)) out[String(c.instId).replace('-USDT-SWAP', '') + '/USDT'] = lev;
  }
  return out;
}

async function levGate() {
  const j = await safeFetch('https://api.gateio.ws/api/v4/futures/usdt/contracts');
  const out = {};
  for (const c of Array.isArray(j) ? j : []) {
    const lev = num(c.leverage_max);
    if (isFinite(lev)) out[String(c.name).replace('_', '/')] = lev;
  }
  return out;
}

async function levKucoin() {
  const j = await safeFetch('https://api-futures.kucoin.com/api/v1/contracts/active');
  const out = {};
  for (const c of j?.data || []) {
    let s = c.symbol;
    if (s.endsWith('M')) s = s.slice(0, -1);
    const [b0, q] = splitQuote(s);
    const b = b0 === 'XBT' ? 'BTC' : b0;
    const lev = num(c.maxLeverage);
    if (isFinite(lev)) out[b + '/' + q] = lev;
  }
  return out;
}

async function levBitget() {
  const j = await safeFetch('https://api.bitget.com/api/v2/mix/market/contracts?productType=usdt-futures');
  const out = {};
  for (const c of j?.data || []) {
    const [b, q] = splitQuote(c.symbol);
    const lev = num(c.maxLever);
    if (isFinite(lev)) out[b + '/' + q] = lev;
  }
  return out;
}

// Binance: публичный bapi сайта (без подписи). Макс. плечо = max(maxOpenPosLeverage) по бракетам символа.
async function levBinance() {
  const j = await safeFetch('https://www.binance.com/bapi/futures/v1/friendly/future/common/brackets');
  const out = {};
  for (const c of j?.data?.brackets || []) {
    const [b, q] = splitQuote(c.symbol);
    let lev = 0;
    for (const rb of c.riskBrackets || []) {
      const m = num(rb.maxOpenPosLeverage);
      if (isFinite(m) && m > lev) lev = m;
    }
    if (lev > 0) out[b + '/' + q] = lev;
  }
  return out;
}

// Aster и BingX плечо публично не отдают: у Aster в /fapi/v1/exchangeInfo поля leverage нет
// вовсе (нужен подписанный leverageBracket), у BingX в /quote/contracts — тоже. Поэтому у них
// в виджете прочерк, и это не баг.
const LEV_FETCHERS = {
  mexc: levMexc, bybit: levBybit, binance: levBinance, gate: levGate,
  okx: levOkx, ourbit: levOurbit, kucoin: levKucoin, bitget: levBitget,
};
const levCache = {}; // id -> { "BTC/USDT": maxLev }

async function refreshLeverage() {
  const ids = Object.keys(LEV_FETCHERS);
  const settled = await Promise.allSettled(ids.map((id) => LEV_FETCHERS[id]()));
  const report = [];
  settled.forEach((res, i) => {
    if (res.status === 'fulfilled') {
      levCache[ids[i]] = res.value;
      report.push(`${ids[i]}:${Object.keys(res.value).length}`);
    } else {
      // Раньше сбой глотался молча и биржа просто оставалась без плеча навсегда.
      report.push(`${ids[i]}:СБОЙ`);
      console.warn(`[spread-monitor] плечо ${ids[i]} не получено: ${res.reason?.message || res.reason}`);
    }
  });
  console.log('[spread-monitor] плечо обновлено —', report.join(' '));
}

// ---------- спотовые цены (для режима Spot: спред спот↔фьючерс) ----------

async function spotBinanceLike(url) { // [{ symbol:"BTCUSDT", price }]
  const j = await safeFetch(url);
  const out = {};
  for (const t of Array.isArray(j) ? j : []) {
    const [b, q] = splitQuote(t.symbol);
    const last = num(t.price);
    if (isFinite(last) && last > 0) out[b + '/' + q] = last;
  }
  return out;
}
const spotMexc = () => spotBinanceLike('https://api.mexc.com/api/v3/ticker/price');
const spotBinance = () => spotBinanceLike('https://api.binance.com/api/v3/ticker/price');

async function spotBybit() {
  const j = await safeFetch('https://api.bybit.com/v5/market/tickers?category=spot');
  const out = {};
  for (const t of j?.result?.list || []) {
    const [b, q] = splitQuote(t.symbol);
    const last = num(t.lastPrice);
    if (isFinite(last) && last > 0) out[b + '/' + q] = last;
  }
  return out;
}

async function spotGate() {
  const j = await safeFetch('https://api.gateio.ws/api/v4/spot/tickers');
  const out = {};
  for (const t of Array.isArray(j) ? j : []) {
    const last = num(t.last);
    if (isFinite(last) && last > 0) out[String(t.currency_pair).replace('_', '/')] = last;
  }
  return out;
}

async function spotBitget() {
  const j = await safeFetch('https://api.bitget.com/api/v2/spot/market/tickers');
  const out = {};
  for (const t of j?.data || []) {
    const [b, q] = splitQuote(t.symbol);
    const last = num(t.lastPr ?? t.last ?? t.close);
    if (isFinite(last) && last > 0) out[b + '/' + q] = last;
  }
  return out;
}

async function spotKucoin() {
  const j = await safeFetch('https://api.kucoin.com/api/v1/market/allTickers');
  const out = {};
  for (const t of j?.data?.ticker || []) {
    const last = num(t.last);
    if (isFinite(last) && last > 0) out[String(t.symbol).replace('-', '/')] = last;
  }
  return out;
}

async function spotBingx() {
  const j = await safeFetch('https://open-api.bingx.com/openApi/spot/v1/ticker/24hr');
  const out = {};
  for (const t of Array.isArray(j?.data) ? j.data : []) {
    const last = num(t.lastPrice ?? t.last ?? t.close);
    if (isFinite(last) && last > 0) out[String(t.symbol).replace('-', '/')] = last;
  }
  return out;
}

// Спот есть у 7 бирж; у Ourbit и Aster спота нет → в режиме Spot будет «—».
const SPOT_FETCHERS = { mexc: spotMexc, binance: spotBinance, bitget: spotBitget, kucoin: spotKucoin };
const spotCache = {}; // id -> { "BTC/USDT": spotLast }

async function refreshSpot() {
  const ids = Object.keys(SPOT_FETCHERS);
  const settled = await Promise.allSettled(ids.map((id) => SPOT_FETCHERS[id]()));
  settled.forEach((res, i) => { if (res.status === 'fulfilled') spotCache[ids[i]] = res.value; });
}

// ---------- market cap (CoinGecko) для фильтра лоу-кап монет ----------

const mcBySymbol = {}; // "BTC" -> market cap (USD); на тикер берём макс. капу

async function refreshMarketCaps() {
  const next = {};
  for (let p = 1; p <= MC_PAGES; p++) {
    let arr;
    try {
      arr = await safeFetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${p}`);
    } catch {
      break; // рейтлимит/сбой — берём что успели набрать
    }
    if (!Array.isArray(arr) || !arr.length) break;
    for (const c of arr) {
      const sym = String(c.symbol || '').toUpperCase();
      const mc = num(c.market_cap);
      if (!sym || !isFinite(mc)) continue;
      if (!(sym in next) || mc > next[sym]) next[sym] = mc;
    }
    await new Promise((r) => setTimeout(r, 1500)); // вежливо к лимиту
  }
  if (Object.keys(next).length) {
    for (const k of Object.keys(mcBySymbol)) delete mcBySymbol[k];
    Object.assign(mcBySymbol, next);
  }
}

function getMc(coin) {
  const c = coin.toUpperCase();
  let mc = mcBySymbol[c];
  if (mc == null && c.startsWith('1000')) mc = mcBySymbol[c.slice(4)]; // 1000PEPE -> PEPE
  return isFinite(mc) ? mc : NaN;
}

// true = пара проходит фильтр капы. Если кэш ещё пуст (CoinGecko не загрузился) — не блокируем (fail-open).
function passesMc(coin) {
  if (Object.keys(mcBySymbol).length === 0) return true;
  return getMc(coin) >= MC_MIN_USD;
}

// ---------- конфиг бирж ----------

// Порядок совпадает с EX_ORDER в content.js, чтобы строки в виджете шли одинаково.
const EXCHANGES = [
  { id: 'mexc',    name: 'MEXC',    color: '#1f3a5a', fetcher: fetchMexc,    url: (b, q) => `https://www.mexc.com/futures/${b}_${q}?type=linear_swap` },
  { id: 'bybit',   name: 'Bybit',   color: '#5a3d1f', fetcher: fetchBybit,   url: (b, q) => `https://www.bybit.com/trade/usdt/${b}${q}` },
  { id: 'binance', name: 'Binance', color: '#5a4a1f', fetcher: fetchBinance, url: (b, q) => `https://www.binance.com/en/futures/${b}${q}` },
  { id: 'gate',    name: 'Gate',    color: '#1f2f5a', fetcher: fetchGate,    url: (b, q) => `https://www.gate.io/futures/USDT/${b}_${q}` },
  { id: 'okx',     name: 'OKX',     color: '#2a2a2a', fetcher: fetchOkx,     url: (b, q) => `https://www.okx.com/trade-swap/${b.toLowerCase()}-${q.toLowerCase()}-swap` },
  { id: 'ourbit',  name: 'Ourbit',  color: '#1f5a4a', fetcher: fetchOurbit,  url: (b, q) => `https://futures.ourbit.com/exchange/${b}_${q}` },
  { id: 'aster',   name: 'Aster',   color: '#3d1f5a', fetcher: fetchAster,   url: (b, q) => `https://www.asterdex.com/en/futures/${b}${q}` },
  { id: 'kucoin',  name: 'KuCoin',  color: '#1f5a30', fetcher: fetchKucoin,  url: (b, q) => `https://www.kucoin.com/futures/trade/${b === 'BTC' ? 'XBT' : b}${q}M` },
  { id: 'bitget',  name: 'Bitget',  color: '#1f4a5a', fetcher: fetchBitget,  url: (b, q) => `https://www.bitget.com/futures/usdt/${b}${q}` },
  { id: 'bingx',   name: 'BingX',   color: '#1f3a5a', fetcher: fetchBingx,   url: (b, q) => `https://bingx.com/en/perpetual/${b}-${q}` },
];

// Фильтр по market cap: отсекаем лоу-кап / неликвид (частая причина ложных спредов и «пампов»).
const MC_MIN_USD = 30 * 1e6; // минимальная капа монеты для алерта — крути под себя
const MC_REFRESH_MS = 5 * 60 * 1000;
const MC_PAGES = 6; // топ ~1500 монет CoinGecko

// ---------- цикл ----------

// Считаем строку «битой», если last=0 (нет сделок / делистинг) или спред нереально большой.
// |spread| > 50% почти всегда означает мёртвый контракт, а не реальную возможность.
function isBadRow(r) {
  if (!isFinite(r.last) || !isFinite(r.fair)) return true;
  if (r.last <= 0 || r.fair <= 0) return true;
  if (Math.abs(r.spreadPct) > 50) return true;
  return false;
}

// Защита от наложения: если предыдущий tick ещё не закончил все запросы (медленная биржа),
// новый не стартуем, чтобы не плодить параллельные fetch и не упереться в rate limit.
let polling = false;

async function pollOnce() {
  if (polling) return;
  polling = true;
  try {
    await doPoll();
  } finally {
    polling = false;
  }
}

// Быстрый цикл только по «своей» бирже: обновляет её строки в уже собранном state,
// не дожидаясь общего круга. Guard не даёт запросам наслаиваться на медленных биржах.
let fastPolling = false;
async function fastPoll() {
  if (fastPolling || !currentState) return;
  const now = Date.now();
  const list = EXCHANGES.filter((e) => now - (activeEx[e.id] || 0) < ACTIVE_TTL_MS);
  if (!list.length) return;
  fastPolling = true;
  try {
    const settled = await Promise.allSettled(list.map((e) => e.fetcher()));
    settled.forEach((res, i) => {
      if (res.status !== 'fulfilled') return;
      const ex = list[i];
      const lev = levCache[ex.id] || {};
      const spot = spotCache[ex.id] || {};
      const rows = res.value
        .map((t) => ({ ...t, spreadPct: ((t.last - t.fair) / t.fair) * 100, maxLev: lev[t.symbol] ?? null, spotLast: spot[t.symbol] ?? null }))
        .filter((r) => !isBadRow(r));
      lastRows[ex.id] = { rows, ts: Date.now() };
      lastFetchAt[ex.id] = Date.now(); // общий цикл может пропустить её как свежую
      if (currentState.exchanges[ex.id]) {
        currentState.exchanges[ex.id].rows = rows;
        currentState.exchanges[ex.id].ok = true;
      }
      currentState.updatedAt = Date.now();
    });
  } finally { fastPolling = false; }
}

// Последние удачные данные по каждой бирже — чтобы колонка не гасла из-за разового сбоя.
let currentState = null;      // свежий срез в памяти воркера
let lastStateSave = 0;
const STATE_SAVE_MS = 5000;   // как часто дублировать state в storage (для попапа)

// Биржи, страницы которых сейчас открыты у пользователя. Их обновляем чаще —
// цена и fair на своей бирже должны шевелиться, а не ждать общий круг по всем десяти.
const activeEx = {};          // id -> ts последнего запроса от вкладки
const ACTIVE_TTL_MS = 30000;  // вкладку закрыли — через полминуты биржа перестаёт быть «активной»
// 1с — компромисс: тикеры весят 400-600КБ, и на 500мс это уже больше мегабайта в секунду,
// биржа начнёт троттлить (ровно так мы уронили Gate). Хочешь чаще — уменьшай осознанно.
const FAST_POLL_MS = 1000;

// Виджет просит данные ТОЛЬКО по своей паре — это ~10 строк вместо ~8000.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Попапу нужна вся таблица — отдаём срез из памяти, он всегда свежее storage.
  if (msg && msg.type === 'sm-state') { sendResponse(currentState || null); return true; }
  if (!msg || msg.type !== 'sm-symbol') return false;
  // Вкладка сообщает, на какой она бирже — её опрашиваем отдельным быстрым циклом.
  if (msg.exId) activeEx[msg.exId] = Date.now();
  const st = currentState;
  if (!st) { sendResponse({ updatedAt: 0, exchanges: {} }); return true; }
  const out = { updatedAt: st.updatedAt, exchanges: {} };
  for (const [id, ex] of Object.entries(st.exchanges)) {
    const row = msg.symbol ? (ex.rows || []).find((r) => r.symbol === msg.symbol) : null;
    out.exchanges[id] = { name: ex.name, ok: ex.ok, error: ex.error, rows: row ? [row] : [] };
  }
  sendResponse(out);
  return true;
});

const CACHED = Symbol('cached'); // маркер «биржу в этот раз не опрашивали»
const lastRows = {}; // id -> { rows, ts }
const STALE_MS = 30000; // при опросе раз в 1.2с разовый сбой не должен гасить колонку
const lastErrLog = {}; // id -> ts последнего залогированного сбоя (троттлинг консоли)

// Замер показал: Gate отдаёт 418КБ за ~300мс на ТЁПЛОМ соединении и за ~4с на холодном
// (TLS-рукопожатие). Редкий опрос давал соединению остыть — и каждый запрос снова был
// холодным и снова падал по таймауту. Поэтому интервал маленький: держим соединение живым.
// Значение — компромисс между свежестью и трафиком (418КБ × частота).
const SLOW_EX_MS = { gate: 2000 };
const lastFetchAt = {};

async function doPoll() {
  const tick = Date.now();
  const settled = await Promise.allSettled(EXCHANGES.map((e) => {
    const gap = SLOW_EX_MS[e.id];
    if (gap && lastRows[e.id] && tick - (lastFetchAt[e.id] || 0) < gap) {
      return Promise.resolve(CACHED); // ещё рано — переиспользуем прошлый ответ
    }
    lastFetchAt[e.id] = tick;
    return e.fetcher();
  }));
  const state = { updatedAt: Date.now(), exchanges: {} };

  settled.forEach((res, i) => {
    const ex = EXCHANGES[i];
    if (res.status === 'fulfilled' && res.value === CACHED) {
      // пропуск по своему интервалу — показываем прошлые данные, они ещё свежие
      const c = lastRows[ex.id];
      state.exchanges[ex.id] = { name: ex.name, color: ex.color, ok: true, rows: c ? c.rows : [] };
      return;
    }
    if (res.status === 'fulfilled') {
      const lev = levCache[ex.id] || {};
      const spot = spotCache[ex.id] || {};
      const rows = res.value
        .map((t) => ({ ...t, spreadPct: ((t.last - t.fair) / t.fair) * 100, maxLev: lev[t.symbol] ?? null, spotLast: spot[t.symbol] ?? null }))
        .filter((r) => !isBadRow(r));
      lastRows[ex.id] = { rows, ts: Date.now() };
      state.exchanges[ex.id] = { name: ex.name, color: ex.color, ok: true, rows };
    } else {
      // запрос упал — показываем последние удачные данные, если они свежие (<15с)
      const cached = lastRows[ex.id];
      const fresh = cached && Date.now() - cached.ts < STALE_MS;
      // Печатаем причину не чаще раза в 30с на биржу — иначе консоль зальёт при опросе 5/с.
      const msg = String(res.reason?.message || res.reason);
      if (Date.now() - (lastErrLog[ex.id] || 0) > 30000) {
        lastErrLog[ex.id] = Date.now();
        console.warn(`[spread-monitor] ${ex.name} не ответил: ${msg}`);
      }
      state.exchanges[ex.id] = {
        name: ex.name, color: ex.color, ok: false,
        error: String(res.reason?.message || res.reason),
        rows: fresh ? cached.rows : [],
        stale: !!fresh,
      };
    }
  });

  // Полный state (~600КБ) держим в памяти и раздаём виджетам по одному символу.
  // Раньше он писался в storage каждый опрос — это ~29МБ/мин на диск, плюс каждая
  // вкладка получала все 8000 строк, чтобы показать десять.
  currentState = state;
  // В storage кладём редко: он нужен попапу и чтобы пережить засыпание воркера.
  if (Date.now() - lastStateSave > STATE_SAVE_MS) {
    lastStateSave = Date.now();
    chrome.storage.local.set({ state }).catch(() => {});
  }
  updateBadge(state);
  alertsMod?.trackPrices(state); // только в приватной сборке
  alertsMod?.runAlerts(state);
}

function updateBadge(state) {
  let max = 0;
  for (const ex of Object.values(state.exchanges)) {
    for (const row of ex.rows) {
      const a = Math.abs(row.spreadPct);
      if (a > max) max = a;
    }
  }
  const text = max >= 10 ? max.toFixed(0) : max.toFixed(1);
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: max >= 1 ? '#d32f2f' : '#444' });
}

let pollTimer = null;
let levTimer = null;
let spotTimer = null;
function startLeverage() {
  if (levTimer) return;
  refreshLeverage();
  levTimer = setInterval(refreshLeverage, 60000);
}
function startSpot() {
  if (spotTimer) return;
  refreshSpot();
  spotTimer = setInterval(refreshSpot, 1500);
}
let mcTimer = null;
function startMc() {
  if (mcTimer) return;
  refreshMarketCaps();
  mcTimer = setInterval(refreshMarketCaps, MC_REFRESH_MS);
}
function startPolling() {
  if (pollTimer) return;
  loadAlertsModule().then(() => alertsMod?.initAlerts({ exchanges: EXCHANGES, passesMc }));
  startLeverage();
  startSpot();
  startMc();
  pollOnce();
  pollTimer = setInterval(pollOnce, POLL_MS);
  setInterval(fastPoll, FAST_POLL_MS); // своя биржа — чаще остальных
}

// Тумблер авто-открытия из попапа.
chrome.storage.onChanged.addListener((c) => {
  alertsMod?.applyStorageChange(c); // тумблер авто-открытия живёт в alerts.js
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('keepalive', { periodInMinutes: 1 });
  startPolling();
});
chrome.runtime.onStartup.addListener(startPolling);
chrome.alarms.onAlarm.addListener(startPolling);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'refresh') {
    pollOnce().then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg?.type === 'urlFor') {
    // Контент-скрипт спрашивает URL пары на бирже
    const ex = EXCHANGES.find((e) => e.id === msg.exId);
    if (!ex || !msg.symbol) { sendResponse(null); return; }
    const [b, q] = msg.symbol.split('/');
    sendResponse(b && q ? ex.url(b, q) : null);
    return;
  }
});

startPolling();
