# Dev/Test → CSP Break-Even Analyser

A single-page tool that reprices an Azure **Dev/Test subscription's** actual usage at **Azure Plan (CSP) retail rates** and calculates the **partner discount at which moving to CSP becomes cheaper** than staying on Dev/Test rates.

**Everything runs in your browser.** The CSV files you provide are parsed locally with JavaScript and are never uploaded anywhere. The only outbound calls are to the public, unauthenticated [Azure Retail Prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices) — to look up retail rates where your export lacks a comparator column, and to price the Windows licensing uplift and reservation rates.

## What you need to provide

### 1. Cost & usage export (required)

One full calendar month, at **subscription scope**:

- **Azure portal** → Cost Management → **Cost analysis** → set the scope to the Dev/Test subscription → **Download** → CSV, or
- A scheduled **"Cost and usage details (actual cost)"** export from Cost Management → Exports.

The tool auto-detects both EA and MCA column naming (`CostInBillingCurrency`, `Quantity`, `MeterId`, `PayGPrice`, etc.). Where the export includes `PayGPrice`, that column is used as the retail comparator; otherwise retail rates are looked up per meter from the Retail Prices API.

### 2. VM inventory (optional but strongly recommended)

Dev/Test bills **Windows VMs at Linux rates with no Windows licence meter**, so the usage export alone cannot tell you which VMs are Windows — and repricing usage alone would understate the CSP cost. Provide a small inventory so the tool can add the licence delta back.

Run this in **Azure Resource Graph Explorer** (portal → search "Resource Graph") and download the results as CSV:

```kusto
Resources
| where type =~ 'microsoft.compute/virtualmachines'
| project name,
          vmSize = tostring(properties.hardwareProfile.vmSize),
          osType = tostring(properties.storageProfile.osDisk.osType),
          location
```

If you have **Azure Hybrid Benefit** rights (Windows Server licences with active Software Assurance), tick the AHB toggle in the tool — the uplift is then not payable and the comparison narrows considerably.

The `vmSize` column is also the **ARM SKU** used to price reservations (see below), and `location` the ARM region, so this same export sharpens the reservation modelling.

## Reservation savings (Azure Plan only)

Dev/Test subscriptions **cannot buy reserved instances** — Azure Plan can. That lever alone often tips a move, so the tool models it:

- Virtual Machines usage in the cost export is grouped by **SKU + region**, and the steady-state instance count is estimated from the consumed hours (`hours ÷ 730`).
- **1-year and 3-year reserved-instance rates** are pulled from the Retail Prices API (`priceType eq 'Reservation'`); the term price is the whole-term total, so the monthly-equivalent is that total ÷ 12 or ÷ 36.
- Each SKU gets a **term selector** (None / 1-year / 3-year) and an editable **reserved quantity**; a "Reserve all at" control sets every SKU at once. The best-saving term is pre-selected to surface the incentive.
- Azure's billing model is honoured: a reservation covers `qty × 730` hours/month at the reserved rate, and any overage falls back to PAYG.

The reservation saving reduces the CSP base **before** the partner discount, and folds into the KPI row, the verdict, the break-even, and the copied summary.

## How the comparison works

| Step | Calculation |
|---|---|
| Current spend | Sum of usage-charge lines (marketplace and purchase charges excluded — they bill identically on either offer) |
| Retail repricing | `Quantity × PayGPrice` per line, or Retail Prices API lookup by `MeterId` where PayGPrice is absent |
| Windows uplift | Per Windows VM: (Windows rate − Linux rate) for its size/region × consumed compute hours (matched from the export where possible, editable per-VM) |
| Reservation saving | Per reserved SKU: `PAYG-priced hours − (qty × 730 × reserved rate + overage × PAYG)` |
| CSP cost at *d*% | `(retail + uplift − reservations) × (1 − d)` |
| **Break-even** | `1 − current ÷ (retail + uplift − reservations)` — the discount above which Azure Plan beats Dev/Test |

Lines with no retail comparator are conservatively treated as having **no Dev/Test discount** (retail = current), so the break-even shown is a floor, not an optimistic estimate.

## What the numbers can't show

- Dev/Test carries **no financially-backed SLA**; Azure Plan restores standard SLAs.
- **Production workloads are prohibited** on Dev/Test offers.
- Dev/Test rates depend on **active Visual Studio subscribers**; CSP removes that dependency.
- **SQL Server VMs** on Dev/Test also bill without the SQL licence meter — if present, the true CSP cost is higher than shown unless AHB covers SQL.
- **Reservations** are modelled from public retail rates and assume steady-state utilisation of the reserved instances; real commitments carry cancellation/exchange rules and capacity considerations, and a partner may pass additional margin on top. **Savings plans** (not modelled) are a more flexible alternative with typically slightly smaller discounts.

## Deploying

This is a single static `index.html` — enable **GitHub Pages** on the repo (Settings → Pages → Deploy from branch → `main` / root) and share the URL. No build step, no backend.

> **Note on the Retail Prices API:** it is called directly from the browser. If a customer's network blocks it, the tool degrades gracefully — a warning is shown, uncovered lines are treated conservatively, and a manual Windows-uplift override field is available.

## Disclaimer

Estimates only. Validate against a formal CSP quote before contracting. Rates, offers and incentive constructs change; this tool compares consumption economics only and is not licensing advice.
