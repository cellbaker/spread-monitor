// На странице любой биржи: возле блока с ценой текущей пары рисуем полоску чипов
// со спредом по всем 9 биржам. Клик по чипу — открыть пару на этой бирже.

(function () {
  if (window.__spreadWidgetLoaded) return;
  window.__spreadWidgetLoaded = true;

  const host = location.hostname;

  // ---------- определение текущей биржи и пары ----------

  function detectExchange() {
    if (host.includes('mexc.com')) return 'mexc';
    if (host.includes('ourbit.com')) return 'ourbit';
    if (host.includes('bybit.com')) return 'bybit';
    if (host.includes('binance.com')) return 'binance';
    if (host.includes('gate.io') || host.includes('gate.com')) return 'gate'; // Gate переехал на .com, старый домен ещё живой
    if (host.includes('okx.com')) return 'okx';
    if (host.includes('asterdex.com')) return 'aster';
    if (host.includes('kucoin.com')) return 'kucoin';
    if (host.includes('bitget.com')) return 'bitget';
    if (host.includes('bingx.com')) return 'bingx';
    return null;
  }

  function detectSymbol(exId) {
    const path = location.pathname + location.search;
    let m;

    // BTC_USDT в пути
    m = path.match(/\/(?:futures|exchange|swap|contract|trade_v2)\/([A-Z0-9]+)_([A-Z0-9]+)/i);
    if (m) return (m[1] + '/' + m[2]).toUpperCase();

    // BTC-USDT в пути
    m = path.match(/\/([A-Z0-9]+)-([A-Z0-9]+)\/?(?:$|\?)/i);
    if (m && /USDT|USDC|USD/i.test(m[2])) return (m[1] + '/' + m[2]).toUpperCase();

    // BTCUSDT (склеенный) — bybit/binance/bitget стиль
    m = path.match(/\/(?:trade|futures)\/(?:usdt|usdc|inverse|spot|forward)?\/?([A-Z0-9]+)/i);
    if (m) {
      const s = m[1].toUpperCase();
      // Особая обработка KuCoin: XBTUSDTM
      if (exId === 'kucoin') {
        let core = s.endsWith('M') ? s.slice(0, -1) : s;
        for (const q of ['USDT', 'USDC', 'USD']) {
          if (core.endsWith(q)) {
            let base = core.slice(0, -q.length);
            if (base === 'XBT') base = 'BTC';
            return base + '/' + q;
          }
        }
      }
      for (const q of ['USDT', 'USDC', 'USD']) {
        if (s.endsWith(q) && s.length > q.length) return s.slice(0, -q.length) + '/' + q;
      }
    }

    // Gate.io: /futures/USDT/BTC_USDT (уже покрыто первой regex), но иногда /futures_trade/usdt/BTC_USDT
    return null;
  }

  const curExId = detectExchange();
  if (!curExId) return;

  // ---------- URL-строители (дубль из background, чтобы не делать round-trip) ----------

  const URL_BUILDERS = {
    mexc:    (b, q) => `https://www.mexc.com/futures/${b}_${q}?type=linear_swap`,
    bybit:   (b, q) => `https://www.bybit.com/trade/usdt/${b}${q}`,
    binance: (b, q) => `https://www.binance.com/en/futures/${b}${q}`,
    gate:    (b, q) => `https://www.gate.io/futures/USDT/${b}_${q}`,
    okx:     (b, q) => `https://www.okx.com/trade-swap/${b.toLowerCase()}-${q.toLowerCase()}-swap`,
    ourbit:  (b, q) => `https://www.ourbit.com/futures/exchange/${b}_${q}`,
    aster:   (b, q) => `https://www.asterdex.com/en/futures/v1/${b}${q}`,
    kucoin:  (b, q) => `https://www.kucoin.com/futures/trade/${b === 'BTC' ? 'XBT' : b}${q}M`,
    bitget:  (b, q) => `https://www.bitget.com/futures/usdt/${b}${q}`,
    bingx:   (b, q) => `https://bingx.com/en-us/perpetual/${b}-${q}`,
  };

  // Спотовые страницы (для режима Spot). У Aster спота нет.
  const SPOT_URL_BUILDERS = {
    mexc:    (b, q) => `https://www.mexc.com/exchange/${b}_${q}`,
    bybit:   (b, q) => `https://www.bybit.com/en/trade/spot/${b}/${q}`,
    binance: (b, q) => `https://www.binance.com/en/trade/${b}_${q}?type=spot`,
    gate:    (b, q) => `https://www.gate.io/trade/${b}_${q}`,
    okx:     (b, q) => `https://www.okx.com/trade-spot/${b.toLowerCase()}-${q.toLowerCase()}`,
    ourbit:  (b, q) => `https://www.ourbit.com/exchange/${b}_${q}`,
    kucoin:  (b, q) => `https://www.kucoin.com/trade/${b}-${q}`,
    bitget:  (b, q) => `https://www.bitget.com/spot/${b}${q}`,
    bingx:   (b, q) => `https://bingx.com/en-us/spot/${b}-${q}`,
  };

  const EX_ORDER = ['mexc', 'bybit', 'binance', 'gate', 'okx', 'ourbit', 'aster', 'kucoin', 'bitget', 'bingx'];
  const EX_NAME = {
    mexc: 'MEXC', bybit: 'Bybit', binance: 'Binance', gate: 'Gate', okx: 'OKX', ourbit: 'Ourbit',
    aster: 'Aster', kucoin: 'KuCoin', bitget: 'Bitget', bingx: 'BingX',
  };
  // Запасной вариант иконки — кружок с монограммой в фирменном цвете биржи.
  // Используется, пока грузится логотип, и навсегда для бирж без логотипа.
  const EX_ICON = {
    mexc:    { ch: 'M', bg: '#1972f5', fg: '#fff' },
    bybit:   { ch: 'B', bg: '#f7a600', fg: '#1a1300' },
    binance: { ch: 'B', bg: '#f0b90b', fg: '#1a1400' },
    gate:    { ch: 'G', bg: '#2354e6', fg: '#fff' },
    okx:     { ch: 'O', bg: '#1a1a1a', fg: '#fff' },
    ourbit:  { ch: 'O', bg: '#00b897', fg: '#00201a' },
    aster:   { ch: 'A', bg: '#8b5cf6', fg: '#fff' },
    kucoin:  { ch: 'K', bg: '#24ae8f', fg: '#00201a' },
    bitget:  { ch: 'B', bg: '#00e5ff', fg: '#002027' },
    bingx:   { ch: 'X', bg: '#2b6cff', fg: '#fff' },
  };
  // Биржи, для которых в icons/ex/ лежит настоящий логотип. Aster фавиконку не отдаёт — у него монограмма.
  const EX_LOGO = new Set(['mexc', 'bybit', 'binance', 'gate', 'okx', 'ourbit', 'kucoin', 'bitget', 'bingx']);

  // ---------- утилиты ----------

  function fmtPct(pct) {
    if (!isFinite(pct)) return '—';
    return (pct > 0 ? '+' : '') + pct.toFixed(3) + '%';
  }
  // Цена со значащими знаками: дешёвые монеты не должны схлопываться в 0.00
  function fmtPrice(p) {
    if (!isFinite(p) || p <= 0) return '';
    if (p >= 1000) return p.toFixed(2);
    if (p >= 1) return p.toFixed(4);
    if (p >= 0.001) return p.toFixed(6);
    return p.toPrecision(4);
  }
  function spreadClass(pct) {
    if (!isFinite(pct) || Math.abs(pct) < 0.001) return '';
    return pct > 0 ? 'sm-pos' : 'sm-neg';
  }
  function parseNum(s) {
    if (!s) return NaN;
    let c = String(s).trim().replace(/\s+/g, '').replace(',', '.');
    // Биржи клеят к цене стрелку направления и знак: «↓0.80850», «▲1.234», «+0.5».
    // Без этой чистки якорь у цены не находится и бейдж не встаёт (случай Bybit).
    c = c.replace(/^[↑↓▲▼△▽⯅⯆+]+/, '').replace(/[↑↓▲▼△▽⯅⯆]+$/, '');
    if (!/^-?\d+(\.\d+)?$/.test(c)) return NaN;
    return parseFloat(c);
  }
  function nearlyEqual(a, b) {
    if (!isFinite(a) || !isFinite(b)) return false;
    const tol = Math.abs(b) * 0.005 + 1e-8; // 0.5% — выдерживает дрейф между нашим polling'ом и WS биржи
    return Math.abs(a - b) <= tol;
  }

  // ---------- спред МЕЖДУ биржами по ПОСЛЕДНЕЙ цене ----------
  // Точка отсчёта — last на текущей бирже (странице, где открыт виджет).
  function refLastFor(symbol, state) {
    const cur = symbol && state?.exchanges?.[curExId]?.rows
      ? state.exchanges[curExId].rows.find((r) => r.symbol === symbol) : null;
    if (cur && isFinite(cur.last) && cur.last > 0) return cur.last;
    // запасной отсчёт — MEXC (если текущей биржи нет в данных)
    const mx = symbol && state?.exchanges?.mexc?.rows
      ? state.exchanges.mexc.rows.find((r) => r.symbol === symbol) : null;
    return mx && isFinite(mx.last) && mx.last > 0 ? mx.last : NaN;
  }
  // Справедливая цена на текущей бирже — вторая точка отсчёта (спред «по fair»).
  function refFairFor(symbol, state) {
    const cur = symbol && state?.exchanges?.[curExId]?.rows
      ? state.exchanges[curExId].rows.find((r) => r.symbol === symbol) : null;
    if (cur && isFinite(cur.fair) && cur.fair > 0) return cur.fair;
    const mx = symbol && state?.exchanges?.mexc?.rows
      ? state.exchanges.mexc.rows.find((r) => r.symbol === symbol) : null;
    return mx && isFinite(mx.fair) && mx.fair > 0 ? mx.fair : NaN;
  }
  // (цена биржи − цена точки отсчёта) / цена точки отсчёта * 100
  function interSpreadPct(price, refPrice) {
    if (!isFinite(price) || price <= 0) return NaN;
    if (!isFinite(refPrice) || refPrice <= 0) return NaN;
    return ((price - refPrice) / refPrice) * 100;
  }
  // Режим Spot: спред (спот − фьючерс) / фьючерс на этой же бирже.
  function spotBasisPct(row) {
    if (!row || !isFinite(row.spotLast) || row.spotLast <= 0) return NaN;
    if (!isFinite(row.last) || row.last <= 0) return NaN;
    return ((row.spotLast - row.last) / row.last) * 100;
  }

  // ---------- поиск anchor'а на странице ----------

  // Штраф за «это похоже на строку списка/стакана»: считаем, сколько соседей у элемента
  // одинаковые по тегу+классу. У блока тикер-статистики соседей мало (funding, объём,
  // хай/лоу — обычно до десятка). У стакана — десятки одинаковых строк, часто больше, чем
  // видно на экране (виртуализация держит буфер сверху/снизу). Порог 10 отделяет одно
  // от другого, не задевая обычные шапки со статистикой.
  const LIST_SIBLING_THRESHOLD = 10;
  function listPenalty(el) {
    const parent = el && el.parentElement;
    if (!parent || !el.tagName) return 0;
    let count = 0;
    for (const sib of parent.children) {
      if (sib !== el && sib.tagName === el.tagName && sib.className === el.className) {
        count++;
        if (count >= LIST_SIBLING_THRESHOLD) return 8; // штраф намного больше типичной err (~0-0.01)
      }
    }
    return 0;
  }

  function findInlineAnchor(lastValue, fairValue) {
    // Ищем text node с fairValue, у которого ближайший ancestor содержит и lastValue.
    // ВАЖНО: mark price почти всегда лежит ВНУТРИ текущего спреда bid/ask — то есть
    // численно совпадает с одной из видимых строк стакана. Точность совпадения (err)
    // одна не спасает: у настоящего заголовка и у совпавшей строки стакана она может
    // быть одинаково нулевой. Различаем структурно — listPenalty() — а не только по числам.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const t = (n.textContent || '').trim();
        if (!t || t.length > 20) return NodeFilter.FILTER_REJECT;
        const num = parseNum(t);
        if (!isFinite(num)) return NodeFilter.FILTER_REJECT;
        return nearlyEqual(num, fairValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });

    const relErr = (a, b) => (isFinite(a) && b ? Math.abs(a - b) / Math.abs(b) : Infinity);

    const candidates = [];
    let n;
    while ((n = walker.nextNode())) {
      const fairEl = n.parentElement;
      if (!fairEl || fairEl.offsetParent === null) continue; // скрытый элемент — не наш случай
      const fairErr = relErr(parseNum((n.textContent || '').trim()), fairValue);
      let anc = fairEl;
      for (let depth = 0; depth < 6 && anc; depth++) {
        const innerWalker = document.createTreeWalker(anc, NodeFilter.SHOW_TEXT);
        let n2, bestLastErr = Infinity;
        while ((n2 = innerWalker.nextNode())) {
          if (n2 === n) continue;
          const v = parseNum((n2.textContent || '').trim());
          if (!nearlyEqual(v, lastValue)) continue;
          const e = relErr(v, lastValue);
          if (e < bestLastErr) bestLastErr = e;
        }
        if (bestLastErr < Infinity) {
          const penalty = listPenalty(fairEl) + listPenalty(anc);
          const top = anc.getBoundingClientRect().top;
          candidates.push({ fairEl, ancestor: anc, depth, err: fairErr + bestLastErr + penalty, top });
          break;
        }
        anc = anc.parentElement;
      }
    }
    // 1) точность+штраф за «это список» — решает почти всегда;
    // 2) при равенстве — кто выше на странице (шапка со статистикой обычно над стаканом);
    // 3) и только потом — глубина в DOM.
    candidates.sort((a, b) => (a.err - b.err) || (a.top - b.top) || (a.depth - b.depth));
    return candidates[0] || null;
  }

  // ---------- сборка полоски чипов ----------

  function buildChip(exId, symbol, row, refs, mode) {
    const a = document.createElement('a');
    a.className = 'sm-chip';
    a.target = '_blank';
    a.rel = 'noopener';

    const isSpot = mode === 'spot';

    const [b, q] = symbol.split('/');
    const builder = (isSpot && SPOT_URL_BUILDERS[exId]) || URL_BUILDERS[exId];
    if (b && q && builder) a.href = builder(b, q);

    // Иконка биржи. Логотип ставим фоном, а не <img>: виджет перерисовывается каждый
    // опрос, и отдельная картинка успевала мигнуть и пропасть. Фон браузер кэширует,
    // моргания нет. У кого логотипа нет (Aster) — кружок с монограммой.
    const ico = EX_ICON[exId];
    const icoEl = document.createElement('span');
    icoEl.className = 'sm-chip-ico';
    if (EX_LOGO.has(exId)) {
      icoEl.classList.add('sm-chip-ico-img');
      icoEl.style.backgroundImage = `url("${chrome.runtime.getURL(`icons/ex/${exId}.png`)}")`;
    } else {
      icoEl.textContent = ico ? ico.ch : (exId[0] || '?').toUpperCase();
      if (ico) { icoEl.style.background = ico.bg; icoEl.style.color = ico.fg; }
    }

    const name = document.createElement('span');
    name.className = 'sm-chip-name';
    name.textContent = EX_NAME[exId] || exId;

    const levEl = document.createElement('span');
    levEl.className = 'sm-chip-lev';
    const lev = !isSpot && row && isFinite(row.maxLev) ? Math.round(row.maxLev) : null;
    levEl.textContent = lev ? lev + 'x' : '';

    // Две колонки процентов = спред МЕЖДУ биржами относительно той, где открыт виджет:
    //   FAIR — по справедливой (mark) цене, LAST — по последней.
    // В режиме Spot вторая колонка не нужна: там показываем базис спот↔фьюч.
    const fairPctEl = document.createElement('span');
    fairPctEl.className = 'sm-chip-pct sm-chip-pct-fair';
    const lastPctEl = document.createElement('span');
    lastPctEl.className = 'sm-chip-pct sm-chip-pct-last';

    const spFair = isSpot ? NaN : interSpreadPct(row ? row.fair : NaN, refs.fair);
    const spLast = isSpot ? spotBasisPct(row) : interSpreadPct(row ? row.last : NaN, refs.last);
    const fpGap = row && isFinite(row.spreadPct) ? row.spreadPct : NaN; // fair↔last внутри биржи

    const paint = (el, v) => {
      if (!isFinite(v)) { el.textContent = '—'; el.classList.add('sm-dim'); return; }
      el.textContent = fmtPct(v);
      const cls = spreadClass(v);
      if (cls) el.classList.add(cls);
    };
    paint(fairPctEl, spFair);
    paint(lastPctEl, spLast);

    if (row) {
      if (exId === curExId) a.classList.add('sm-chip-cur'); // сама точка отсчёта
      a.title = isSpot
        ? `${EX_NAME[exId] || exId} ${symbol}\nспот ${row.spotLast} · фьюч ${row.last}\nспот↔фьюч → ${fmtPct(spLast)}\n${a.href}`
        : `${EX_NAME[exId] || exId} ${symbol}\n`
          + `fair ${fmtPrice(row.fair)} · last ${fmtPrice(row.last)}\n`
          + `спред к ${EX_NAME[curExId] || curExId}:\n`
          + `  по fair → ${fmtPct(spFair)}\n`
          + `  по last → ${fmtPct(spLast)}\n`
          + `fair↔last внутри биржи → ${isFinite(fpGap) ? fmtPct(fpGap) : '—'}`
          + `${lev ? `\nмакс. плечо ${lev}x` : ''}\n${a.href}`;
    } else {
      a.classList.add('sm-missing');
      a.title = isSpot ? `${EX_NAME[exId] || exId}: спот ${symbol} не найден` : `${EX_NAME[exId] || exId}: пара ${symbol} не найдена`;
    }

    if (isSpot) a.append(icoEl, name, levEl, lastPctEl);
    else a.append(icoEl, name, levEl, fairPctEl, lastPctEl);
    return a;
  }

  // Полоса, которую инжектим в DOM рядом с ценой.
  function makeStrip() {
    const strip = document.createElement('div');
    strip.className = 'sm-strip';
    strip.dataset.spreadStrip = '1';
    return strip;
  }

  // ---------- плавающий fallback ----------

  let floatPanel = null;
  let viewMode = 'futures'; // 'futures' | 'spot' — переключатель в шапке виджета

  function setMode(m) {
    viewMode = m === 'spot' ? 'spot' : 'futures';
    chrome.storage.local.set({ viewMode });
    pull();
  }

  function buildFloatEl() {
    const el = document.createElement('div');
    el.id = 'spread-monitor-widget';
    el.innerHTML = `
      <div class="sm-head">
        <span class="sm-symbol" id="sm-symbol">—</span>
        <span class="sm-cur-fair" id="sm-cur-fair"></span>
        <span class="sm-toggle">
          <button class="sm-tg" data-mode="futures">Fut</button>
          <button class="sm-tg" data-mode="spot">Spot</button>
        </span>
        <span class="sm-drag" title="перетащить">⋮⋮</span>
        <span class="sm-close" title="скрыть">×</span>
      </div>
      <div class="sm-body" id="sm-body"></div>
      <div class="sm-foot" id="sm-foot">—</div>
      <div class="sm-credit">Created by <b>@cellbaker</b></div>
    `;

    el.querySelector('.sm-close').addEventListener('click', () => el.classList.toggle('sm-hidden'));
    el.querySelectorAll('.sm-tg').forEach((btn) =>
      btn.addEventListener('click', () => setMode(btn.dataset.mode)));

    const drag = el.querySelector('.sm-drag');
    let dragging = false, offX = 0, offY = 0;
    drag.addEventListener('mousedown', (e) => {
      dragging = true;
      const r = el.getBoundingClientRect();
      offX = e.clientX - r.left; offY = e.clientY - r.top; e.preventDefault();
    });
    const onMove = (e) => {
      if (!dragging) return;
      el.style.left = (e.clientX - offX) + 'px';
      el.style.top = (e.clientY - offY) + 'px';
      el.style.right = 'auto'; el.style.bottom = 'auto';
    };
    const onUp = () => {
      if (dragging) {
        dragging = false;
        chrome.storage.local.set({ widgetPos: { left: el.style.left, top: el.style.top } });
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);

    chrome.storage.local.get('widgetPos', ({ widgetPos }) => {
      if (widgetPos?.left) {
        el.style.left = widgetPos.left;
        el.style.top = widgetPos.top;
        el.style.right = 'auto'; el.style.bottom = 'auto';
      }
    });

    return el;
  }

  function ensureFloat() {
    // Каждый вызов: сметаем дубли — оставляем только наш floatPanel или ничего.
    const all = document.querySelectorAll('#spread-monitor-widget');
    for (const node of all) if (node !== floatPanel) node.remove();

    if (floatPanel?.isConnected) return floatPanel;

    floatPanel = buildFloatEl();
    document.documentElement.appendChild(floatPanel);
    return floatPanel;
  }

  // Fair (mark) price ТЕКУЩЕЙ биржи прямо в шапке НАШЕГО виджета. Раньше пытались вписать
  // это значение в чужую вёрстку страницы — ненадёжно (виртуализация стакана, разный DOM
  // на 10 биржах, чужие фреймворки затирают вставленное). Здесь узел полностью наш,
  // ничего стороннего его не может подменить или унести в другое место.
  function fillCurFair(panel, symbol, state) {
    const el = panel.querySelector('#sm-cur-fair');
    const exData = state?.exchanges?.[curExId];
    const row = symbol && exData?.rows ? exData.rows.find((r) => r.symbol === symbol) : null;
    el.classList.remove('sm-pos', 'sm-neg');
    if (!row || !isFinite(row.fair) || row.fair <= 0) {
      el.textContent = '';
      el.title = '';
      return;
    }
    // % спреда fair↔last, а не цена: last выше fair — премия, лонг-сетап, зелёный «+»;
    // last ниже fair — дисконт, шорт-сетап, «-». fmtPct сам ставит знак (обычный дефис).
    el.textContent = fmtPct(row.spreadPct);
    const cls = spreadClass(row.spreadPct);
    if (cls) el.classList.add(cls);
    el.title = `Справедливая цена на ${EX_NAME[curExId] || curExId}\n`
      + `fair ${fmtPrice(row.fair)} · last ${fmtPrice(row.last)}\n`
      + `fair↔last → ${fmtPct(row.spreadPct)}`;
  }

  function renderFloat(symbol, state) {
    const panel = ensureFloat();
    panel.querySelector('#sm-symbol').textContent = symbol || '?';
    fillCurFair(panel, symbol, state);
    panel.querySelectorAll('.sm-tg').forEach((bt) => bt.classList.toggle('sm-tg-on', bt.dataset.mode === viewMode));

    const body = panel.querySelector('#sm-body');
    body.innerHTML = '';
    const refs = { last: refLastFor(symbol, state), fair: refFairFor(symbol, state) };

    // Шапка колонок — без неё непонятно, где спред по fair, а где по last.
    const head = document.createElement('div');
    head.className = 'sm-cols';
    head.innerHTML = viewMode === 'spot'
      ? '<span class="sm-cols-ex">биржа</span><span class="sm-cols-lev">плечо</span><span class="sm-cols-c">спот↔фьюч</span>'
      : '<span class="sm-cols-ex">биржа</span><span class="sm-cols-lev">плечо</span><span class="sm-cols-c">fair</span><span class="sm-cols-c">last</span>';
    body.appendChild(head);

    for (const id of EX_ORDER) {
      const exData = state?.exchanges?.[id];
      const row = symbol && exData?.rows ? exData.rows.find((r) => r.symbol === symbol) : null;
      const chip = buildChip(id, symbol || '', row, refs, viewMode);
      chip.classList.add('sm-row-chip');
      // Биржа не ответила — показываем причину в подсказке, а не молчаливый прочерк.
      if (exData && exData.ok === false && exData.error) {
        chip.classList.add('sm-exfail');
        chip.title = `${EX_NAME[id] || id}: биржа не отвечает\n${exData.error}`;
      }
      body.appendChild(chip);
    }

    const ago = state?.updatedAt ? Math.round((Date.now() - state.updatedAt) / 1000) : '?';
    const modeLabel = viewMode === 'spot'
      ? 'базис спот↔фьюч'
      : `спред к ${EX_NAME[curExId] || curExId}`;
    panel.querySelector('#sm-foot').textContent = `${modeLabel} · обновлено ${ago}с назад`;
  }

  // ---------- инлайн-полоса ----------

  let inlinePrimary = null;
  let inlineStrip = null;
  let inlineAnchorRef = null; // {fairEl, ancestor}

  function clearInline() {
    if (inlinePrimary?.parentNode) inlinePrimary.remove();
    if (inlineStrip?.parentNode) inlineStrip.remove();
    inlinePrimary = null;
    inlineStrip = null;
    inlineAnchorRef = null;
    document.querySelectorAll('[data-spread-strip], [data-spread-primary]').forEach((el) => el.remove());
  }

  // Бейдж у цены = спред fair↔last на ТЕКУЩЕЙ бирже (отклонение last от справедливой цены).
  function fillPrimary(badge, row) {
    badge.textContent = row ? fmtPct(row.spreadPct) : '—';
    badge.classList.remove('sm-pos', 'sm-neg');
    if (row) {
      const cls = spreadClass(row.spreadPct);
      if (cls) badge.classList.add(cls);
      badge.title = `${curExId.toUpperCase()} · спред fair↔last · last ${row.last} · fair ${row.fair}`;
    }
  }

  // Грубая проверка «якорь ещё наш»: биржи виртуализируют стакан — одна и та же DOM-нода
  // при скролле переиспользуется под другую строку, а .contains() этого не видит (нода
  // осталась в документе, просто теперь показывает другую цену). Допуск широкий (1.5%),
  // чтобы не дёргать бейдж на обычном движении рынка между опросами — ловим только
  // грубую подмену (чужая строка), а не рыночный дрейф.
  function anchorStillFresh(anchorRef, fairValue) {
    if (!anchorRef?.fairEl) return false;
    const live = parseNum((anchorRef.fairEl.textContent || '').trim());
    if (!isFinite(live) || !isFinite(fairValue) || fairValue === 0) return false;
    return Math.abs(live - fairValue) / Math.abs(fairValue) <= 0.015;
  }

  function tryInjectInline(symbol, state) {
    const exData = state?.exchanges?.[curExId];
    const curRow = symbol && exData?.rows ? exData.rows.find((r) => r.symbol === symbol) : null;
    if (!curRow) return false;

    // Уже вставлено, anchor живой и всё ещё показывает нашу цену — просто обновим текст.
    if (
      inlinePrimary && document.body.contains(inlinePrimary) &&
      inlineAnchorRef?.fairEl && document.body.contains(inlineAnchorRef.fairEl) &&
      anchorStillFresh(inlineAnchorRef, curRow.fair)
    ) {
      fillPrimary(inlinePrimary, curRow);
      return true;
    }

    const anchor = findInlineAnchor(curRow.last, curRow.fair);
    if (!anchor) return false;

    if (inlinePrimary?.parentNode) inlinePrimary.remove();

    inlinePrimary = document.createElement('span');
    inlinePrimary.className = 'sm-primary';
    inlinePrimary.dataset.spreadPrimary = '1';
    fillPrimary(inlinePrimary, curRow);

    const fairEl = anchor.fairEl;
    const parent = fairEl.parentElement;
    // Вставляем только primary-бейдж (спред fair↔last) сразу после fair. Полоска бирж убрана.
    parent.insertBefore(inlinePrimary, fairEl.nextSibling);
    inlineAnchorRef = anchor;
    return true;
  }

  function fillStrip(strip, symbol, state) {
    strip.innerHTML = '';
    const refs = { last: refLastFor(symbol, state), fair: refFairFor(symbol, state) };
    for (const id of EX_ORDER) {
      const exData = state?.exchanges?.[id];
      const row = symbol && exData?.rows ? exData.rows.find((r) => r.symbol === symbol) : null;
      strip.appendChild(buildChip(id, symbol, row, refs));
    }
  }

  // ---------- цикл обновления ----------

  let lastSymbol = null;

  function applyState(state) {
    const symbol = detectSymbol(curExId);
    if (symbol !== lastSymbol) {
      lastSymbol = symbol;
      clearInline();
    }

    renderFloat(symbol, state);
    if (symbol && state) tryInjectInline(symbol, state);
  }

  // Просим у воркера данные ТОЛЬКО по текущей паре (~10 строк вместо ~8000).
  // Раньше вкладка получала весь state через storage.onChanged — это грузило и диск, и вкладку.
  function pull() {
    const symbol = detectSymbol(curExId);
    chrome.runtime.sendMessage({ type: 'sm-symbol', symbol, exId: curExId }, (resp) => {
      if (chrome.runtime.lastError) return; // воркер спит/перезапускается — просто ждём следующий тик
      if (resp) applyState(resp);
      else chrome.storage.local.get('state', ({ state }) => applyState(state)); // запасной путь
    });
  }

  chrome.storage.onChanged.addListener((c) => {
    if (c.viewMode) { viewMode = c.viewMode.newValue || 'futures'; pull(); }
  });

  chrome.storage.local.get('viewMode', ({ viewMode: vm }) => { if (vm) viewMode = vm; pull(); });

  // Свой таймер обновления: виджет больше не зависит от того, как часто пишется storage.
  const PULL_MS = 700;
  setInterval(pull, PULL_MS);

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      clearInline();
      pull();
    }
  }, 500);

  // SPA-перерисовка может удалить нашу полоску — раз в секунду пробуем переинжектить
  setInterval(pull, 1000);

  pull();
})();
