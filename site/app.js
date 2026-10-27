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
const ownUrlOk = (url) => {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    return u.hostname === 'www.sec.gov' || u.hostname === 'sec.gov'
      || u.hostname === 'www.nasdaq.com' || u.hostname === 'nasdaq.com'
      || u.hostname === 'contents.xj-storage.jp'
      || u.hostname === 'metaplanet.jp' || u.hostname === 'www.metaplanet.jp';
  } catch { return false; }
};
const fmtPct = (n) => n == null || !isFinite(n) ? '—' : `${n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
function holderLine(h) {
  const pct = fmtPct(h.pct);
  const when = h.as_of_label ? ` as of ${h.as_of_label}` : '';
  const src = [h.source, h.report].filter(Boolean).join(', ');
  const label = `${esc(h.name)} — ${esc(fmtN(h.shares))} shares — ${esc(pct)}${esc(when)}${src ? ` — ${esc(src)}` : ''}`;
  const extra = h.preferred_excluded
    ? ` ${esc(fmtN(h.preferred_excluded))} non-voting Class B preferred shares in that filing are not included.`
    : '';
  if (ownUrlOk(h.url)) return `<li><a href="${esc(h.url)}" target="_blank" rel="noopener">${label}</a>${extra}</li>`;
  return `<li>${label}${extra}</li>`;
}
function ownershipBody(o) {
  const parts = [];
  if (o.reported === false) {
    parts.push(`<p>${esc(o.reason || 'Not reported.')}</p>`);
  } else if (o.unavailable || o.pct == null) {
    parts.push(`<p>${esc(o.reason || 'Institutional ownership is unavailable.')}</p>`);
  } else {
    parts.push(`<p>${esc(fmtPct(o.pct))} = ${esc(fmtN(o.institutional_shares))} institutional shares ÷ ${esc(fmtN(o.basic_shares))} basic shares outstanding.${o.holders_count ? ` ${esc(fmtN(o.holders_count))} holders.` : ''} ${esc(o.as_of_label || 'Form 13F')}. The percent uses the basic shares on this page, not a third-party percent.</p>`);
  }
  const holders = o.holders || [];
  const owners = holders.filter((h) => h.group !== 'register');
  const register = holders.filter((h) => h.group === 'register');
  const heading = o.fallback_top
    ? 'No reported holder is above 5% of current basic shares. Largest reported holders:'
    : 'Above 5% of current basic shares:';
  if (owners.length) parts.push(`<h3>${esc(heading)}</h3><ul>${owners.map(holderLine).join('')}</ul>`);
  else if (!register.length && o.reported !== false) parts.push(`<p>${esc(heading)}</p>`);
  if (register.length) {
    const regHead = o.fallback_top && !owners.length
      ? heading
      : 'Shareholder register, above 5% of current basic shares. These are names on the register, often a standing proxy, not a confirmed single beneficial owner:';
    parts.push(`<h3>${esc(regHead)}</h3><ul>${register.map(holderLine).join('')}</ul>`);
  }
  if (!owners.length && !register.length && o.reported === false) {
    parts.push('<p>No holder above 5% of current basic shares was found in the saved disclosures.</p>');
  }
  for (const note of o.notes || []) parts.push(`<p class="note">${esc(note)}</p>`);
  return parts.join('');
}
function ownershipCell(c) {
  const o = c.ownership;
  if (!o) return '<td class="own">—<span class="s">unavailable</span></td>';
  const id = `own-${esc(c.id)}`;
  let fig = '—';
  let sub = 'unavailable';
  let label = 'Institutional ownership unavailable';
  if (o.reported === false) {
    fig = 'Not reported';
    sub = '';
    label = `Institutional ownership not reported for ${c.name}. Show holders.`;
  } else if (!o.unavailable && o.pct != null) {
    fig = fmtPct(o.pct);
    sub = o.as_of_label || '';
    label = `Institutional ownership ${fig}${sub ? `, ${sub}` : ''}. Show holders.`;
  }
  const subHtml = sub ? `<span class="s">${esc(sub)}</span>` : '';
  return `<td class="own"><button type="button" class="own-btn" aria-expanded="false" aria-controls="${id}" aria-label="${esc(label)}"><span class="own-fig">${esc(fig)}</span>${subHtml}</button><div id="${id}" class="own-pop" popover="manual" role="dialog" aria-label="${esc(`Institutional ownership, ${c.name}`)}">${ownershipBody(o)}</div></td>`;
}
function bindOwnershipTips() {
  document.querySelectorAll('body > .own-pop').forEach((n) => n.remove());
  document.querySelectorAll('.own-btn').forEach((btn) => {
    const pop = document.getElementById(btn.getAttribute('aria-controls'));
    if (!pop || typeof pop.showPopover !== 'function') return;
    let overBtn = false;
    let overPop = false;
    let hideTimer = 0;
    const place = () => {
      const r = btn.getBoundingClientRect();
      const width = Math.min(448, window.innerWidth - 16);
      pop.style.position = 'fixed';
      pop.style.margin = '0';
      pop.style.inset = 'auto';
      pop.style.width = `${width}px`;
      const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
      let top = r.bottom + 6;
      pop.style.left = `${left}px`;
      pop.style.top = `${top}px`;
      const h = pop.offsetHeight;
      if (top + h > window.innerHeight - 8) pop.style.top = `${Math.max(8, r.top - h - 6)}px`;
    };
    const show = () => {
      clearTimeout(hideTimer);
      if (pop.parentElement !== document.body) document.body.appendChild(pop);
      if (!pop.matches(':popover-open')) pop.showPopover();
      btn.setAttribute('aria-expanded', 'true');
      place();
    };
    const hide = () => {
      clearTimeout(hideTimer);
      if (btn.dataset.pinned === '1') return;
      if (pop.matches(':popover-open')) pop.hidePopover();
      btn.setAttribute('aria-expanded', 'false');
    };
    const scheduleHide = () => {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => { if (!overBtn && !overPop) hide(); }, 150);
    };
    const isMouse = (e) => !e.pointerType || e.pointerType === 'mouse';
    btn.addEventListener('pointerenter', (e) => {
      if (!isMouse(e)) return;
      overBtn = true;
      show();
    });
    btn.addEventListener('pointerleave', (e) => {
      if (!isMouse(e)) return;
      overBtn = false;
      scheduleHide();
    });
    btn.addEventListener('focus', () => show());
    btn.addEventListener('blur', () => {
      overBtn = false;
      setTimeout(() => { if (!pop.contains(document.activeElement)) scheduleHide(); }, 0);
    });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.dataset.pinned === '1') {
        btn.dataset.pinned = '0';
        hide();
        return;
      }
      btn.dataset.pinned = '1';
      show();
    });
    pop.addEventListener('pointerenter', () => { overPop = true; clearTimeout(hideTimer); });
    pop.addEventListener('pointerleave', () => { overPop = false; scheduleHide(); });
    pop.addEventListener('toggle', () => {
      if (!pop.matches(':popover-open')) btn.setAttribute('aria-expanded', 'false');
    });
  });
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
      ${ownershipCell(c)}
      <td>₿${fmtN(c.btc_holdings)}<span class="s">as of ${c.balance_sheet_as_of || '—'}</span></td>
      ${filingCell(c)}
    </tr>`);
  }
  document.querySelector('#valuation tbody').innerHTML = valuation.join('');
  document.querySelector('#holdings tbody').innerHTML = holdings.join('');
  bindOwnershipTips();
  document.getElementById('errors').textContent = d.errors?.length ? 'Data warnings: ' + d.errors.join('; ') : '';
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  document.querySelectorAll('.own-pop').forEach((pop) => {
    if (pop.matches(':popover-open')) pop.hidePopover();
  });
  document.querySelectorAll('.own-btn').forEach((btn) => { btn.dataset.pinned = '0'; btn.setAttribute('aria-expanded', 'false'); });
});
document.addEventListener('click', (e) => {
  document.querySelectorAll('.own-btn').forEach((btn) => {
    if (btn.dataset.pinned !== '1') return;
    const pop = document.getElementById(btn.getAttribute('aria-controls'));
    if (!pop || btn.contains(e.target) || pop.contains(e.target)) return;
    btn.dataset.pinned = '0';
    if (pop.matches(':popover-open')) pop.hidePopover();
    btn.setAttribute('aria-expanded', 'false');
  });
});
load(); setInterval(load, 5 * 60 * 1000);
