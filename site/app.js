const fmtN = (n, d = 0) => n == null ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
const fmtUSD = (n, d = 2) => n == null ? '—' : '$' + fmtN(n, d);
const big = (n) => n == null ? '—' : n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' : '$' + (n / 1e6).toFixed(1) + 'M';
const mult = (x) => x == null ? '<span class="m">—</span>' : `<span class="m ${x >= 1 ? 'prem' : 'disc'}">${x.toFixed(2)}×</span>`;
const fmtQuote = (amount, currency, usd) => {
  if (amount == null) return '—';
  if (currency === 'USD') return fmtUSD(amount);
  return `${currency === 'JPY' ? '¥' : ''}${fmtN(amount, currency === 'JPY' ? 0 : 2)} ${currency === 'JPY' ? '' : currency}<span class="s">≈ ${fmtUSD(usd)}</span>`;
};
const fmtQuoteCompact = (amount, currency, usd) => {
  if (amount == null) return '—';
  if (!currency || currency === 'USD') return fmtUSD(amount);
  const sym = currency === 'JPY' ? '¥' : '';
  const digits = currency === 'JPY' ? 0 : 2;
  const code = currency === 'JPY' ? '' : ' ' + currency;
  return `${sym}${fmtN(amount, digits)}${code} (≈ ${fmtUSD(usd)})`;
};
const local = (iso) => iso ? new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }) : '—';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDay = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  return m ? `${MONTHS_SHORT[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : '';
};
const vsDate = (prev, current) => {
  const a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(prev || '');
  if (!a) return prev ? `vs ${prev}` : '';
  const md = `${MONTHS_SHORT[Number(a[2]) - 1]} ${Number(a[3])}`;
  const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(current || '');
  return `vs ${md}${b && a[1] !== b[1] ? `, ${a[1]}` : ''}`;
};
function closeSubtext(stock) {
  if (!stock || stock.close == null || !stock.symbol) return '';
  const amount = stock.currency === 'JPY' ? `¥${fmtN(stock.close, 0)}`
    : !stock.currency || stock.currency === 'USD' ? fmtUSD(stock.close)
      : `${fmtN(stock.close, 2)} ${stock.currency}`;
  return `<span class="s">${esc(`${stock.symbol} ${amount} (close)`)}</span>`;
}
function stockPriceCell(c) {
  const mcap = `<span class="s">mcap ${big(c.market_cap_usd)}</span>`;
  const s = c.stock;
  if (!s) return `<td>—${mcap}</td>`;
  const d = s.display;
  if (d && d.price != null) {
    const label = d.symbol ? ` <span class="px-ticker">${esc(d.symbol)}</span>` : '';
    const basis = s.symbol
      ? `Live ${d.symbol} quote. Valuation uses ${s.symbol}.`
      : `Live ${d.symbol} quote.`;
    return `<td><span title="${esc(basis)}">${fmtQuote(d.price, d.currency, d.price_usd)}${label}</span>${closeSubtext(s)}${mcap}</td>`;
  }
  const note = s.display_fallback ? `<span class="s">${esc(s.display_fallback)}</span>` : '';
  return `<td>${fmtQuote(s.price, s.currency, s.price_usd)}${note}${mcap}</td>`;
}
function shareChangeCell(c) {
  const ch = c.share_change;
  if (!ch || ch.direction === 'none' || ch.previous_as_of == null || ch.delta == null) {
    return '<td>—<span class="s">no prior count yet</span></td>';
  }
  const amount = fmtN(Math.abs(ch.delta));
  const main = ch.direction === 'up' ? `▲ ${amount}`
    : ch.direction === 'down' ? `▼ ${amount}`
    : 'Unchanged';
  return `<td>${main}<span class="s">${esc(vsDate(ch.previous_as_of, ch.as_of))}</span></td>`;
}
const filingUrlOk = (url) => {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    return u.hostname === 'www.sec.gov' || u.hostname === 'sec.gov'
      || u.hostname === 'contents.xj-storage.jp'
      || u.hostname === 'metaplanet.jp' || u.hostname === 'www.metaplanet.jp';
  } catch { return false; }
};
function statusClass(status) {
  if (status === 'newer') return 'filing-new';
  if (status === 'current') return 'filing-ok';
  return '';
}
function secFilingCell(f) {
  const label = `${esc(f.form)} · ${esc(fmtDay(f.filing_date))}`;
  const tip = esc([f.entity_name, f.cik ? `CIK ${f.cik}` : ''].filter(Boolean).join(' · '));
  const body = filingUrlOk(f.url)
    ? `<a class="filing-sec" href="${esc(f.url)}" target="_blank" rel="noopener" title="${tip}">${label}</a>`
    : `<span title="${tip}">${label}</span>`;
  const note = f.note ? `<span class="s ${statusClass(f.status)}">${esc(f.note)}</span>` : '';
  return `<td class="filing">${body}${note}</td>`;
}
function metaplanetFilingCell(f) {
  const titleCls = f.material ? 'filing-title filing-material' : 'filing-title';
  const label = `${esc(fmtDay(f.filing_date))}<span class="${titleCls}">${esc(f.title || '')}</span>`;
  const tip = esc(f.title || '');
  const body = filingUrlOk(f.url)
    ? `<a href="${esc(f.url)}" target="_blank" rel="noopener" title="${tip}">${label}</a>`
    : `<span title="${tip}">${label}</span>`;
  const list = (f.newer || []).map((n) => `${fmtDay(n.date)} — ${n.title}`).join('\n');
  const noteTip = list ? ` title="${esc(list)}"` : '';
  const note = f.note ? `<span class="s ${statusClass(f.status)}"${noteTip}>${esc(f.note)}</span>` : '';
  return `<td class="filing">${body}${note}</td>`;
}
function filingCell(c) {
  const f = c.filing || (c.sec ? { source: 'sec', ...c.sec } : null);
  if (!f) return '<td class="filing"><span class="s">No filing check</span></td>';
  const sec = f.source === 'sec' || (!f.source && f.form);
  if (f.status === 'unavailable' || !f.filing_date || (sec && !f.form)) {
    const label = sec ? 'SEC check unavailable' : 'Filing check unavailable';
    return `<td class="filing"><span class="s">${label}</span></td>`;
  }
  return sec ? secFilingCell(f) : metaplanetFilingCell(f);
}

async function load() {
  // Unique URL plus no-store: GitHub Pages sends Cache-Control max-age=600, and a
  // fresh index.html must not keep painting the previous data.json.
  const d = await (await fetch('data.json?t=' + Date.now(), { cache: 'no-store' })).json();
  document.getElementById('btc').textContent = fmtUSD(d.btc.usd, 0);
  document.getElementById('updated').textContent = local(d.generated_at);
  const valuation = [];
  const holdings = [];
  for (const c of d.companies) {
    const currency = c.stock?.currency || 'USD';
    const rnav = c.residual_nav_per_share_usd == null ? '—'
      : (currency !== 'USD' && c.residual_nav_per_share_native != null
        ? fmtQuote(c.residual_nav_per_share_native, currency, c.residual_nav_per_share_usd)
        : fmtQuote(c.residual_nav_per_share_usd, 'USD', c.residual_nav_per_share_usd));
    const rTotal = c.residual_nav_usd != null ? `<span class="s">residual ${big(c.residual_nav_usd)}</span>` : '';
    const rDil = c.diluted_shares && c.residual_nav_per_share_diluted_usd != null
      ? `<span class="s">fully diluted ${currency !== 'USD' && c.residual_nav_per_share_diluted_native != null
        ? fmtQuoteCompact(c.residual_nav_per_share_diluted_native, currency, c.residual_nav_per_share_diluted_usd)
        : fmtUSD(c.residual_nav_per_share_diluted_usd)}</span>`
      : '';
    const tracker = c.cebe_tracker?.cebe_mnav_live != null ? `<span class="s"><a href="${c.cebe_tracker.url}" style="color:inherit">cebetracker: ${c.cebe_tracker.cebe_mnav_live.toFixed(2)}×</a></span>` : '';
    const company = `<td class="name"><a href="${c.website}" target="_blank" rel="noopener">${c.name}</a><span class="s">${c.ticker} · ${c.exchange}</span></td>`;
    valuation.push(`<tr>
      ${company}
      ${stockPriceCell(c)}
      <td>${rnav}${rTotal}${rDil}</td>
      <td>${mult(c.basic_mnav)}<span class="s">NAV ${big(c.btc_nav_usd)}</span></td>
      <td>${mult(c.ev_mnav)}<span class="s">EV ${big(c.ev_usd)}</span></td>
      <td>${mult(c.cebe_mnav)}<span class="s">claims ${c.senior_claims_pct == null ? '—' : c.senior_claims_pct.toFixed(1) + '%'}</span>${tracker}</td>
    </tr>`);
    holdings.push(`<tr>
      ${company}
      <td>${fmtN(c.basic_shares)}<span class="s">${c.diluted_shares ? 'fully diluted ' + fmtN(c.diluted_shares) : 'basic'}</span></td>
      ${shareChangeCell(c)}
      <td>₿${fmtN(c.btc_holdings)}<span class="s">as of ${c.balance_sheet_as_of || '—'}</span></td>
      ${filingCell(c)}
    </tr>`);
  }
  document.querySelector('#valuation tbody').innerHTML = valuation.join('');
  document.querySelector('#holdings tbody').innerHTML = holdings.join('');
  document.getElementById('errors').textContent = d.errors?.length ? 'Data warnings: ' + d.errors.join('; ') : '';
}
load(); setInterval(load, 5 * 60 * 1000);
