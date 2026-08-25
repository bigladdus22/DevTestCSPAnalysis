# Dev/Test → CSP Break-Even Analyser

A single-page tool that reprices an Azure **Dev/Test subscription's** actual usage at **Azure Plan (CSP) retail rates** and calculates the **partner discount at which moving to CSP becomes cheaper** than staying on Dev/Test rates.

**Everything runs in your browser.** The CSV files you provide are parsed locally with JavaScript and are never uploaded anywhere. The only outbound calls are to the public, unauthenticated [Azure Retail Prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices) — to look up retail rates where your export lacks a comparator column, and to price the Windows licensing uplift and reservation rates.

## Getting the data (three routes, all supported)

The tool auto-detects which shape of export you gave it and adapts. Step **02 · What your export supports** in the UI then states, row by row, what your particular file can and can't answer and what to do about each gap — so a zero is never unexplained.

### Route 1 — Cost analysis download (fastest, no setup)

Azure portal → **Cost Management** → **Cost analysis**, scoped to the Dev/Test subscription → switch the view to **Cost by resource** → set the range to one full calendar month → **Download → CSV**.

That file has `ResourceId`, `ServiceName`, `ServiceTier`, `Meter`, `ResourceLocation`, `Cost`, `Currency` — but **no `Quantity` and no unit prices**. The tool handles it by *deriving* quantities: each line's cost divided by that meter's retail unit rate (Azure Retail Prices API) is its quantity. That recovers VM hours, and with them the whole reservation model.

What it can't do is detect a per-meter Dev/Test rate discount — with no unit price in the file, the Dev/Test rate is assumed to equal the PAYG rate. That's true for VMs (before Windows licensing) and for storage, but understates CSP cost where Dev/Test genuinely discounts a meter (App Service, Logic Apps, Cloud Services, HDInsight). **The break-even from this route is therefore a floor.** Needs outbound access to `prices.azure.com`.

### Route 2 — Cloud Shell (best data, one paste)

Open Cloud Shell (Bash) and paste the block shown in the app. It pages through the Consumption `usageDetails` API for the previous full calendar month and writes `devtest-usage.csv`, then pops a download:

```bash
sub=$(az account show --query id -o tsv)
end=$(date -u +%Y-%m-01); start=$(date -u -d "$end -1 month" +%Y-%m-%d)
url="https://management.azure.com/subscriptions/$sub/providers/Microsoft.Consumption/usageDetails?api-version=2021-10-01&metric=ActualCost&%24expand=meterDetails&%24top=1000&%24filter=properties%2FusageStart%20ge%20%27$start%27%20and%20properties%2FusageEnd%20lt%20%27$end%27"
# ... pages on nextLink, emits CSV via jq, then: download devtest-usage.csv
```

This is the same data a scheduled export produces — `Quantity`, `MeterId` and **`PayGPrice`** per line — without waiting for an export to run. Every line is then priced **entirely offline**; the Retail Prices API is used only for reservation rates.

### Route 3 — Cost Management export (best data, scheduled)

Cost Management → **Exports** → **Create** → **"Cost and usage details (actual cost)"**, subscription scope, daily granularity, to a storage account. Richest file, fully offline. Use it if you want a recurring feed; Route 2 gets you the same columns in a minute.

### VM inventory (optional but strongly recommended, any route)

Dev/Test bills **Windows VMs at Linux rates with no Windows licence meter**, so the usage export alone cannot tell you which VMs are Windows — and repricing usage alone would understate the CSP cost. Without this file the Windows uplift is assumed to be zero.

Cloud Shell, no extensions needed:

```bash
az vm list -o json | jq -r '(["name","vmSize","osType","location"]|@csv),(.[]|[.name,.hardwareProfile.vmSize,.storageProfile.osDisk.osType,.location]|@csv)' > vm-inventory.csv
download vm-inventory.csv
```

Or Resource Graph Explorer (portal → search "Resource Graph") → run, then **Download as CSV**:

```kusto
Resources
| where type =~ 'microsoft.compute/virtualmachines'
| project name,
          vmSize = tostring(properties.hardwareProfile.vmSize),
          osType = tostring(properties.storageProfile.osDisk.osType),
          location
```

If you have **Azure Hybrid Benefit** rights (Windows Server licences with active Software Assurance), tick the AHB toggle — the uplift is then not payable and the comparison narrows considerably.

`vmSize` is also the exact **ARM SKU** used to price reservations and `location` the ARM region, so the same file sharpens the reservation modelling.

### Input handling

- **Column names** are matched loosely (exact normalised match, then suffix), so EA, MCA and portal-download spellings all land — `CostInBillingCurrency`/`Cost`, `MeterCategory`/`ServiceName`, `MeterName`/`Meter`.
- **Region display names are translated to ARM names** (`EU North` → `northeurope`, `US East 2` → `eastus2`). Without this every retail lookup for a portal CSV silently misses.
- A **title/filter preamble** above the real header row is detected and skipped.
- CSV can be **pasted as text** instead of uploaded, for machines where the download lands somewhere the file picker can't reach.
- Marketplace and purchase charges are excluded from the repricing — they bill identically on either offer.

### When `prices.azure.com` is blocked

Some corporate networks block the Retail Prices API. Nothing errors out; the tool degrades and says so:

- **Route 2 or 3 files** are unaffected for repricing — `PayGPrice` is in the file.
- **Reservation rates** fall back to the assumed 1-yr/3-yr discounts you set in step 04, applied to the PAYG rate.
- **The PAYG rate itself** falls back to an *implied* rate: that SKU's compute spend ÷ its hours. Dev/Test bills compute at the Linux PAYG rate, so cost ÷ hours is the PAYG rate to within rounding. With a VM inventory supplying instance counts, the reservation model therefore still works with **no outbound calls at all** (such rows are marked *implied*).
- **Route 1 files** lose quantity derivation entirely in this case — supply the inventory, or use Route 2.

## Reservation savings (Azure Plan only)

Dev/Test subscriptions **cannot buy reserved instances** — Azure Plan can. That lever alone often tips a move, so the tool models it:

- When a **VM inventory CSV is provided**, reservation SKUs come straight from its `vmSize` (the exact ARM SKU) and `location`, with the instance count taken from the number of VMs per SKU/region and hours matched from the cost export by VM name. This is more accurate than reconstructing SKUs from meter names (which mangles constrained-core and combined-meter SKUs like `D2/D2s v3`).
- Without an inventory, Virtual Machines usage in the cost export is grouped by **SKU + region** (SKU reconstructed from the meter name), and the steady-state instance count is estimated from the consumed hours (`hours ÷ 730`).
- **1-year and 3-year reserved-instance rates** are pulled from the Retail Prices API (`priceType eq 'Reservation'`); the term price is the whole-term total, so the monthly-equivalent is that total ÷ 12 or ÷ 36.
- Each SKU gets a **term selector** (None / 1-year / 3-year) and an editable **reserved quantity**; a "Reserve all at" control sets every SKU at once. The best-saving term is pre-selected to surface the incentive.
- Azure's billing model is honoured: a reservation covers `qty × 730` hours/month at the reserved rate, and any overage falls back to PAYG.

The reservation saving reduces the CSP base **before** the partner discount, and folds into the KPI row, the verdict, the break-even, and the copied summary.

## All-up business case

A consolidated panel rolls everything together **per month and annualised**, presented as a waterfall so each lever is visible:

- Current Dev/Test spend and the Azure Plan (CSP) cost **before reservations** (retail repricing + Windows uplift, at the selected discount).
- **Extra cost of Azure Plan retail rates vs Dev/Test** — Dev/Test rates are genuinely cheaper than PAYG retail, so this is usually a cost against moving.
- **Reservation saving** — shown as an explicit saving because reservations are an **Azure Plan-only lever** (Dev/Test can't use them); the figure matches the reservation table total.
- **Support / SLA opportunity value** — an editable **% of current spend** (default 10%) representing the risk currently carried by running these workloads with *no SLA and no support* on Dev/Test, which Azure Plan restores.
- The **all-up value of moving**, monthly and yearly (the sum of the three deltas above).

The support value is an assumption you set; everything else is derived from the export and your reservation/discount choices. Reservations are applied as a flat saving on top of the discounted cost, so the reservation figure stays consistent across the reservation table, the all-up panel and the summary.

A **Summary** capstone at the bottom of the results restates the whole picture — discount applied, break-even, Dev/Test spend, CSP cost (with the uplift and reservation contributions as memo lines), direct saving, support value and the all-up total — and updates live as you move the discount slider or change any reservation, uplift or support input.

## Exporting

- **Download PDF report** — uses the browser's print-to-PDF. The input controls, buttons and slider handle are hidden by a print stylesheet, leaving a clean report (verdict, KPIs, uplift, reservations, all-up business case, service breakdown, caveats). Nothing leaves the browser.
- **Copy summary to clipboard** — a plain-text summary including the all-up figures.

## How the comparison works

| Step | Calculation |
|---|---|
| Current spend | Sum of usage-charge lines (marketplace and purchase charges excluded — they bill identically on either offer) |
| Quantity | The export's `Quantity` column, or — where the export has none — `cost ÷ meter's retail unit rate` |
| Retail repricing | `Quantity × PayGPrice` per line, or Retail Prices API lookup by `MeterId` where PayGPrice is absent |
| Windows uplift | Per Windows VM: (Windows rate − Linux rate) for its size/region × consumed compute hours (matched from the export where possible, editable per-VM) |
| Reservation saving | Per reserved SKU: `PAYG-priced hours − (qty × 730 × reserved rate + overage × PAYG)` |
| CSP cost at *d*% | `(retail + uplift − reservations) × (1 − d)` |
| **Break-even** | `1 − current ÷ (retail + uplift − reservations)` — the discount above which Azure Plan beats Dev/Test |

Lines with no retail comparator are conservatively treated as having **no Dev/Test discount** (retail = current), so the break-even shown is a floor, not an optimistic estimate. On Route 1 that applies to every line by construction — see the caveat there.

## What the numbers can't show

- Dev/Test carries **no financially-backed SLA**; Azure Plan restores standard SLAs.
- **Production workloads are prohibited** on Dev/Test offers.
- Dev/Test rates depend on **active Visual Studio subscribers**; CSP removes that dependency.
- **SQL Server VMs** on Dev/Test also bill without the SQL licence meter — if present, the true CSP cost is higher than shown unless AHB covers SQL.
- **Reservations** are modelled from public retail rates and assume steady-state utilisation of the reserved instances; real commitments carry cancellation/exchange rules and capacity considerations, and a partner may pass additional margin on top. **Savings plans** (not modelled) are a more flexible alternative with typically slightly smaller discounts.

## Deploying

This is a single static `index.html` — enable **GitHub Pages** on the repo (Settings → Pages → Deploy from branch → `main` / root) and share the URL. No build step, no backend.

> **Note on the Retail Prices API:** it is called directly from the browser. If a customer's network blocks it the tool degrades gracefully rather than failing — see *When `prices.azure.com` is blocked* above.

## Disclaimer

Estimates only. Validate against a formal CSP quote before contracting. Rates, offers and incentive constructs change; this tool compares consumption economics only and is not licensing advice.
