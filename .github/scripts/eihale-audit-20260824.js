const fs = require('fs');
const { chromium } = require('playwright');

const TARGET_NUMERIC = '24/08/2026';
const TARGET_LONG = '24 Ağustos 2026';
const BASE = 'https://eihale.gov.tr/ihaleler';
const OUT = 'live-output-20260824';
const clean = (s = '') => s.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
const moneyNumber = (s = '') => {
  const m = String(s).match(/[\d.]+(?:,\d+)?/);
  return m ? Number(m[0].replace(/\./g, '').replace(',', '.')) : null;
};
const timeFromLong = (s = '') => (s.match(/24 Ağustos 2026\s+(\d{2}:\d{2})/i) || [,''])[1];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function field(lines, label) {
  const target = label.toLocaleLowerCase('tr-TR');
  const idx = lines.findIndex((line) => line.toLocaleLowerCase('tr-TR') === target);
  if (idx < 0) return '';
  for (let i = idx + 1; i < Math.min(lines.length, idx + 7); i += 1) {
    if (lines[i]) return clean(lines[i]);
  }
  return '';
}

function descriptionData(lines) {
  let start = lines.findIndex((line) => /^Açıklama \*?$/i.test(line));
  if (start < 0) start = lines.findIndex((line) => line === 'İHALE DETAYLARI');
  if (start < 0) return { description: '', items: [], risks: [] };
  let end = lines.findIndex((line, idx) => idx > start && /^(Expertiz Raporu|Ekspertiz Raporu|call|444 8 482|2021 eihale\.gov\.tr)/i.test(line));
  if (end < 0) end = lines.length;
  const section = lines.slice(start + 1, end).map(clean).filter(Boolean);
  const itemPattern = /(\d[\d.,]*\s*(ADET|Adet|ÇİFT|Çift|KİLOGRAM|Kilogram|KG|Gram|RULO|Rulo|TAKIM|Takım|SET|Set|KUTU|Kutu|KAP|Kap|PAKET|Paket|METRE|Metre|M²|m²|LİTRE|Litre|TON|Ton))|\/\/\s*\d+/i;
  const riskPattern = /(EK MALİ|GÜMRÜK VERGİSİ|KDV|ÖTV|IMEİ|IMEI|ŞİFRE|PAROLA|I-CLOUD|ICLOUD|KULLANILMIŞ|HASAR|KIRIK|EKSİK|ÇALIŞIR|ÇALIŞMA|YENİDEN İHRAÇ|FUMİGASYON|İLAÇLAMA|GARANTİ|TESCİL|RUHSAT|HURDA|ATIK|SERTİFİKA|TEST EDİL|AKTİVASYON|BATARYA|AMBALAJSIZ|KUTUSUZ)/i;
  return {
    description: section.join('\n'),
    items: [...new Set(section.filter((x) => itemPattern.test(x)))],
    risks: [...new Set(section.filter((x) => riskPattern.test(x)))]
  };
}

async function goto(page, url, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
      await page.waitForTimeout(3500 + i * 1200);
      return;
    } catch (error) {
      last = error;
      await sleep(1500 * (i + 1));
    }
  }
  throw last;
}

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'tr-TR',
    timezoneId: 'Europe/Istanbul',
    viewport: { width: 1440, height: 1200 },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0 Safari/537.36'
  });
  const list = await context.newPage();
  const candidateUrls = new Set();
  const listPages = [];
  let seenTarget = false;
  let noTargetAfterSeen = 0;

  for (let skip = 0; skip <= 960; skip += 48) {
    const url = `${BASE}?skipCount=${skip}&maxResultCount=48`;
    try {
      await goto(list, url);
      const body = clean(await list.locator('body').innerText());
      const hrefs = await list.locator('a[href*="/ihaleler/detay/"]').evaluateAll((as) => [...new Set(as.map((a) => a.href))]);
      const hasTarget = body.includes(TARGET_NUMERIC);
      listPages.push({ skip, url: list.url(), hasTarget, hrefCount: hrefs.length, sample: body.slice(0, 1200) });
      if (hasTarget) {
        seenTarget = true;
        noTargetAfterSeen = 0;
        hrefs.forEach((href) => candidateUrls.add(href));
      } else if (seenTarget) {
        noTargetAfterSeen += 1;
        if (noTargetAfterSeen >= 2) break;
      }
    } catch (error) {
      listPages.push({ skip, url, error: String(error) });
    }
  }

  const urls = [...candidateUrls];
  const auctions = [];
  const errors = [];
  let cursor = 0;
  const workers = Math.min(6, Math.max(1, urls.length));

  async function worker(id) {
    const page = await context.newPage();
    while (true) {
      const idx = cursor++;
      if (idx >= urls.length) break;
      const url = urls[idx];
      try {
        await goto(page, url);
        const body = clean(await page.locator('body').innerText());
        const lines = body.split(/\n/).map(clean).filter(Boolean);
        const end = field(lines, 'İhale Bitiş Tarihi:');
        if (!end.includes(TARGET_LONG)) continue;
        const desc = descriptionData(lines);
        const starting = field(lines, 'Başlangıç Bedeli:');
        const currentMatch = body.match(/Güncel Fiyat:\s*([\d.]+(?:,\d+)?)\s*₺/i);
        const current = currentMatch ? `${currentMatch[1]} ₺` : starting;
        const title = clean((await page.title()).replace(/^E-İhale\s*\|\s*/i, ''));
        auctions.push({
          title,
          url,
          time: timeFromLong(end),
          end,
          auctionNumber: field(lines, 'İhale Numarası:'),
          business: field(lines, 'İşletme Müdürlüğü:'),
          mainCategory: field(lines, 'Ana Kategori:'),
          subCategory: field(lines, 'Alt Kategori:'),
          itemCategory: field(lines, 'Eşya Kategori:'),
          location: field(lines, 'Bulunduğu Yer:'),
          extraFinancial: field(lines, 'Ek Mali Yükümlülük:'),
          liquidationReason: field(lines, 'Tasfiye Nedeni:'),
          appraisal: field(lines, 'Satışa Esas Bedel:'),
          deposit: field(lines, 'Teminat Bedeli:'),
          starting,
          current,
          startingNumber: moneyNumber(starting),
          currentNumber: moneyNumber(current),
          appraisalNumber: moneyNumber(field(lines, 'Satışa Esas Bedel:')),
          depositNumber: moneyNumber(field(lines, 'Teminat Bedeli:')),
          itemLines: desc.items,
          riskLines: desc.risks,
          description: desc.description
        });
      } catch (error) {
        errors.push({ url, worker: id, error: String(error) });
      }
    }
    await page.close();
  }

  await Promise.all(Array.from({ length: workers }, (_, i) => worker(i)));
  auctions.sort((a, b) => a.time.localeCompare(b.time) || a.title.localeCompare(b.title, 'tr'));
  const generatedAt = new Date().toISOString();
  fs.writeFileSync(`${OUT}/summary.json`, JSON.stringify({
    generatedAt,
    targetDate: TARGET_LONG,
    targetListPages: listPages.filter((x) => x.hasTarget).length,
    candidateLinks: urls.length,
    verifiedAuctions: auctions.length,
    firstEnd: auctions[0]?.end || null,
    lastEnd: auctions.at(-1)?.end || null,
    listPages,
    errors
  }, null, 2));
  fs.writeFileSync(`${OUT}/auctions.json`, JSON.stringify(auctions, null, 2));

  let md = `# 24 Ağustos 2026 E-İhale Canlı Kataloğu\n\nTarama: **${generatedAt}**  \nDoğrulanan lot: **${auctions.length}**\n\n> Canlı teklifler tarama anına aittir.\n\n`;
  md += '| Saat | İhale | Başlangıç | Canlı | Satışa esas | Teminat | Ek yük |\n|---:|---|---:|---:|---:|---:|---|\n';
  md += auctions.map((a) => `| ${a.time} | [${a.title.replace(/\|/g, '/')} ](${a.url}) | ${a.starting || '—'} | ${a.current || '—'} | ${a.appraisal || '—'} | ${a.deposit || '—'} | ${a.extraFinancial || '—'} |`).join('\n');
  md += '\n\n';
  for (const a of auctions) {
    md += `## ${a.time} — ${a.title}\n\n`;
    md += `- Detay: ${a.url}\n- İhale no: ${a.auctionNumber || '—'}\n- İşletme: ${a.business || '—'}\n- Yer: ${a.location || '—'}\n- Kategori: ${a.itemCategory || a.subCategory || a.mainCategory || '—'}\n- Başlangıç / canlı: ${a.starting || '—'} / ${a.current || '—'}\n- Satışa esas / teminat: ${a.appraisal || '—'} / ${a.deposit || '—'}\n- Ek mali yük: ${a.extraFinancial || '—'}\n- Tasfiye nedeni: ${a.liquidationReason || '—'}\n- Bitiş: ${a.end}\n\n`;
    md += `### Ürünler\n${a.itemLines.length ? a.itemLines.map((x) => `- ${x}`).join('\n') : '- Ayrıştırılamadı; tam açıklama JSON dosyasında.'}\n\n`;
    if (a.riskLines.length) md += `### Risk/özel şartlar\n${a.riskLines.map((x) => `- ${x}`).join('\n')}\n\n`;
  }
  fs.writeFileSync(`${OUT}/catalog.md`, md);
  await browser.close();
})().catch((error) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(`${OUT}/fatal.txt`, String(error && error.stack || error));
  process.exitCode = 1;
});
