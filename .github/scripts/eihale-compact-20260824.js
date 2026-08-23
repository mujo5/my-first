const fs = require('fs');

const source = 'live-output-20260824/auctions.json';
const outJsonl = 'live-output-20260824/compact.jsonl';
const outMd = 'live-output-20260824/inventory-index.md';
const auctions = JSON.parse(fs.readFileSync(source, 'utf8'));

const clean = (value = '') => String(value).replace(/\s+/g, ' ').trim();
const short = (value, max) => {
  const text = clean(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const compact = auctions.map((auction, index) => {
  const items = auction.itemLines || [];
  const row = {
    index: index + 1,
    time: auction.time,
    title: auction.title,
    url: auction.url,
    current: auction.current,
    starting: auction.starting,
    appraisal: auction.appraisal,
    deposit: auction.deposit,
    business: auction.business,
    location: auction.location,
    category: auction.itemCategory || auction.subCategory || auction.mainCategory,
    extraFinancial: auction.extraFinancial,
    items,
    risks: auction.riskLines || []
  };
  if (!items.length) row.description = auction.description || '';
  return row;
});

fs.writeFileSync(outJsonl, compact.map((row) => JSON.stringify(row)).join('\n') + '\n');

let md = '# 24 Ağustos 2026 E-İhale Envanter İndeksi\n\n';
md += `Toplam doğrulanmış lot: **${compact.length}**\n\n`;
md += '| # | Saat | İhale | Canlı | Teminat | Yer | Ürün özeti | Risk özeti |\n';
md += '|---:|---:|---|---:|---:|---|---|---|\n';
for (const row of compact) {
  const fallback = row.items.length ? row.items.join(' • ') : row.description || '';
  const items = short(fallback, 520).replace(/\|/g, '/');
  const risks = short(row.risks.join(' • '), 280).replace(/\|/g, '/');
  md += `| ${row.index} | ${row.time} | [${row.title.replace(/\|/g, '/')}](${row.url}) | ${row.current || '—'} | ${row.deposit || '—'} | ${short(row.location, 90).replace(/\|/g, '/')} | ${items || '—'} | ${risks || '—'} |\n`;
}
fs.writeFileSync(outMd, md);
