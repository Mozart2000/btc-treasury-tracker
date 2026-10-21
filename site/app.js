const fmtN = (n, d = 0) => n == null ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
const fmtUSD = (n, d = 2) => n == null ? '—' : '$' + fmtN(n, d);
const big = (n) => n == null ? '—' : n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' : '$' + (n / 1e6).toFixed(1) + 'M';
const mult = (x) => x == null ? '<span class="m">—</span>' : `<span class="m ${x >= 1 ? 'prem' : 'disc'}">${x.toFixed(2)}×</span>`;
const local = (iso) => iso ? new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }) : '—';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDay = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  return m ? `${MONTHS_SHORT[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : '';
};
const secUrlOk = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'www.sec.gov' || u.hostname === 'sec.gov');
  } catch { return false; }
};
function secCell(c) {
  const s = c.sec;
  if (!s) return '<td class="sec"><span class="s">Not an SEC filer</span></td>';
  if (s.status === 'unavailable' || !s.form || !s.filing_date) {
    return '<td class="sec"><span class="s">SEC check unavailable</span></td>';
  }
  const label = `${esc(s.form)} · ${esc(fmtDay(s.filing_date))}`;
  const tip = esc([s.entity_name, s.cik ? `CIK ${s.cik}` : ''].filter(Boolean).join(' · '));
  const body = secUrlOk(s.url)
    ? `<a href="${esc(s.url)}" target="_blank" rel="noopener" title="${tip}">${label}</a>`
    : `<span title="${tip}">${label}</span>`;
  const cls = s.status === 'newer' ? 'sec-new' : (s.status === 'current' ? 'sec-ok' : '');
  const note = s.note ? `<span class="s ${cls}">${esc(s.note)}</span>` : '';
  return `<td class="sec">${body}${note}</td>`;
}

async function load() {
  const d = await (await fetch('data.json?t=' + Date.now())).json();
  document.getElementById('btc').textContent = fmtUSD(d.btc.usd, 0);
  document.getElementById('updated').textContent = local(d.generated_at);
  document.querySelector('#tbl tbody').innerHTML = d.companies.map((c) => {
    const px = c.stock ? (c.stock.currency === 'USD' ? fmtUSD(c.stock.price) :
      `${c.stock.currency === 'JPY' ? '¥' : ''}${fmtN(c.stock.price, c.stock.currency === 'JPY' ? 0 : 2)} ${c.stock.currency === 'JPY' ? '' : c.stock.currency}<span class="s">≈ ${fmtUSD(c.stock.price_usd)}</span>`) : '—';
    const tracker = c.cebe_tracker?.cebe_mnav_live != null ? `<span class="s"><a href="${c.cebe_tracker.url}" style="color:inherit">cebetracker: ${c.cebe_tracker.cebe_mnav_live.toFixed(2)}×</a></span>` : '';
    return `<tr>
      <td class="name"><a href="${c.website}" target="_blank" rel="noopener">${c.name}</a><span class="s">${c.ticker} · ${c.exchange}</span></td>
      <td>${px}<span class="s">mcap ${big(c.market_cap_usd)}</span></td>
      <td>${fmtN(c.basic_shares)}<span class="s">${c.diluted_shares ? 'fully diluted ' + fmtN(c.diluted_shares) : 'basic'}</span></td>
      <td>₿${fmtN(c.btc_holdings)}<span class="s">as of ${c.balance_sheet_as_of || '—'}</span></td>
      <td>${mult(c.basic_mnav)}<span class="s">NAV ${big(c.btc_nav_usd)}</span></td>
      <td>${mult(c.ev_mnav)}<span class="s">EV ${big(c.ev_usd)}</span></td>
      <td>${mult(c.cebe_mnav)}<span class="s">claims ${c.senior_claims_pct == null ? '—' : c.senior_claims_pct.toFixed(1) + '%'}</span>${tracker}</td>
      ${secCell(c)}
    </tr>`;
  }).join('');
  document.getElementById('errors').textContent = d.errors?.length ? 'Data warnings: ' + d.errors.join('; ') : '';
}
load(); setInterval(load, 5 * 60 * 1000);
