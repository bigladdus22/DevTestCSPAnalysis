#!/usr/bin/env node
/*
 * Builds the price snapshot the page reads instead of calling the Azure Retail
 * Prices API from the browser.
 *
 * Why: prices.azure.com does not send CORS headers, so browsers block a static
 * page from reading it, and many corporate networks block it outright. This
 * script runs server-side (GitHub Actions, weekly), where CORS doesn't apply,
 * and writes small same-origin JSON files under prices/.
 *
 * Output (all prices USD, Microsoft's pricing currency):
 *   prices/manifest.json   asOf, region list, FX factors, SQL licence rates
 *   prices/<region>.json   VM and App Service rates for one ARM region
 *
 * VM row:  [linuxPayg, windowsPayg, devTestWindows, ri1yTotal, ri3yTotal, sp1yHourly, sp3yHourly]
 * App row: [payg, devTest]                key = "<normalised sku>|w" or "|l" (Linux)
 *
 * Non-USD retail prices are USD x one fixed factor per currency (checked to
 * within ~0.1% across ~900 VM meters), so other currencies are served by FX
 * factors rather than duplicate files.
 *
 * Usage: node scripts/build-price-snapshot.mjs [region ...]
 * No dependencies; needs Node 18+ (global fetch).
 */
import { mkdir, writeFile } from 'node:fs/promises';

const API = 'https://prices.azure.com/api/retail/prices';
const OUT = new URL('../prices/', import.meta.url);
const REGIONS = `eastus eastus2 westus westus2 westus3 centralus northcentralus southcentralus westcentralus
northeurope westeurope uksouth ukwest francecentral francesouth germanywestcentral germanynorth
switzerlandnorth switzerlandwest norwayeast norwaywest swedencentral swedensouth polandcentral italynorth
spaincentral austriaeast eastasia southeastasia japaneast japanwest koreacentral koreasouth centralindia
southindia westindia australiaeast australiasoutheast australiacentral australiacentral2 canadacentral
canadaeast brazilsouth brazilsoutheast southafricanorth southafricawest uaenorth uaecentral qatarcentral
israelcentral mexicocentral newzealandnorth indonesiacentral malaysiawest chilecentral`.split(/\s+/);
const CURRENCIES = ['AUD','BRL','CAD','CHF','CNY','DKK','EUR','GBP','INR','JPY','KRW','NOK','NZD','SEK','TWD'];
const SQL_LICENCE_PRODUCTS = [
  'SQL Database Single/Elastic Pool General Purpose - SQL License',
  'SQL Database Single/Elastic Pool Business Critical - SQL License',
  'SQL Managed Instance General Purpose - SQL License',
  'SQL Managed Instance Business Critical - SQL License',
];

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const r6 = v => (v == null ? null : Math.round(v * 1e6) / 1e6);
const min = a => (a.length ? Math.min(...a) : null);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const noSpot = i => !/spot|low priority/i.test(`${i.skuName || ''} ${i.meterName || ''}`);
const isWin = i => /windows/i.test(i.productName || '');

async function getJson(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      if (!r.ok) throw new Error(`HTTP ${r.status} (not retried)`);
      return await r.json();
    } catch (e) {
      if (attempt >= 5 || /not retried/.test(e.message)) throw new Error(`${e.message} for ${url}`);
      await sleep(1000 * 2 ** attempt);
    }
  }
}
async function all(filter, { currency = 'USD', preview = false } = {}) {
  let next = `${API}?${preview ? 'api-version=2023-01-01-preview&' : ''}currencyCode='${currency}'&$filter=${encodeURIComponent(filter)}`;
  const items = [];
  while (next) {
    const j = await getJson(next);
    items.push(...(j.Items || []));
    next = j.NextPageLink || null;
  }
  return items;
}

async function buildRegion(arm) {
  const vmItems = (await all(`serviceName eq 'Virtual Machines' and armRegionName eq '${arm}'`, { preview: true })).filter(noSpot);
  const bySku = new Map();
  for (const i of vmItems) {
    if (!i.armSkuName) continue;
    if (!bySku.has(i.armSkuName)) bySku.set(i.armSkuName, []);
    bySku.get(i.armSkuName).push(i);
  }
  const vm = {};
  for (const [sku, items] of bySku) {
    const type = i => i.type || i.priceType;
    const linItem = items.filter(i => type(i) === 'Consumption' && !isWin(i) && !/cloudservice/i.test(i.productName || ''))
                         .sort((a, b) => a.retailPrice - b.retailPrice)[0];
    const lin = linItem ? linItem.retailPrice : null;
    const win = min(items.filter(i => type(i) === 'Consumption' && isWin(i)).map(i => i.retailPrice));
    const dev = min(items.filter(i => type(i) === 'DevTestConsumption' && isWin(i)).map(i => i.retailPrice));
    const ri = t => min(items.filter(i => type(i) === 'Reservation' && i.reservationTerm === t && !isWin(i)).map(i => i.retailPrice));
    const sp = t => { const s = (linItem?.savingsPlan || []).find(x => x.term === t); return s ? s.retailPrice : null; };
    if (lin == null && win == null) continue;
    vm[sku] = [lin, win, dev, ri('1 Year'), ri('3 Years'), sp('1 Year'), sp('3 Years')].map(r6);
  }

  const appItems = await all(`serviceName eq 'Azure App Service' and armRegionName eq '${arm}' and (priceType eq 'Consumption' or priceType eq 'DevTestConsumption')`);
  const app = {};
  for (const i of appItems) {
    const sku = norm(i.skuName);
    if (!sku || !(/app$/i.test(i.meterName || '') || norm(i.meterName) === sku)) continue;
    const key = `${sku}|${/linux/i.test(i.productName || '') ? 'l' : 'w'}`;
    const row = app[key] || (app[key] = [null, null]);
    const k = (i.type || i.priceType) === 'DevTestConsumption' ? 1 : 0;
    row[k] = row[k] == null ? i.retailPrice : Math.min(row[k], i.retailPrice);
  }
  for (const k in app) { if (app[k][0] == null) delete app[k]; else app[k] = app[k].map(r6); }
  return { region: arm, vm, app };
}

async function buildFx() {
  // Factor per currency = median(price_ccy / price_usd) over a reference meter set.
  const ref = `armRegionName eq 'westeurope' and serviceName eq 'Virtual Machines' and priceType eq 'Consumption'`;
  const usd = new Map((await all(ref)).map(i => [`${i.meterId}|${i.skuName}`, i.retailPrice]));
  const fx = { USD: 1 };
  for (const c of CURRENCIES) {
    const ratios = (await all(ref, { currency: c }))
      .map(i => { const u = usd.get(`${i.meterId}|${i.skuName}`); return u > 0.05 ? i.retailPrice / u : null; })
      .filter(Boolean).sort((a, b) => a - b);
    if (ratios.length > 20) fx[c] = r6(ratios[Math.floor(ratios.length / 2)]);
  }
  return fx;
}

async function buildSqlLicence() {
  const out = {};
  for (const p of SQL_LICENCE_PRODUCTS) {
    const items = await all(`priceType eq 'Consumption' and productName eq '${p}'`);
    out[p] = r6(min(items.filter(i => i.armRegionName === 'Global' && i.retailPrice > 0).map(i => i.retailPrice)));
  }
  return out;
}

async function main() {
  const regions = process.argv.slice(2).length ? process.argv.slice(2) : REGIONS;
  await mkdir(OUT, { recursive: true });
  const done = [], failed = [];
  const queue = [...regions];
  const worker = async () => {
    while (queue.length) {
      const arm = queue.shift();
      try {
        const data = await buildRegion(arm);
        if (!Object.keys(data.vm).length) { failed.push(`${arm} (no VM rates)`); continue; }
        await writeFile(new URL(`${arm}.json`, OUT), JSON.stringify(data));
        done.push(arm);
        console.log(`${arm}: ${Object.keys(data.vm).length} VM SKUs, ${Object.keys(data.app).length} App Service SKUs`);
      } catch (e) { failed.push(`${arm} (${e.message})`); }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  const manifest = {
    asOf: new Date().toISOString().slice(0, 10),
    currency: 'USD',
    source: 'Azure Retail Prices API (prices.azure.com)',
    regions: done.sort(),
    fx: await buildFx(),
    sqlLicence: await buildSqlLicence(),
  };
  await writeFile(new URL('manifest.json', OUT), JSON.stringify(manifest, null, 1));
  console.log(`\n${done.length} region(s) written, as of ${manifest.asOf}.`);
  if (failed.length) console.log(`Not written: ${failed.join('; ')}`);
  // Fail the job only if most regions failed, so one bad region doesn't block a refresh.
  if (done.length < regions.length / 2) process.exit(1);
}
main().catch(e => { console.error(e); process.exit(1); });
