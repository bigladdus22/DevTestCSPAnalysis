# Dev/Test → CSP Break-Even Analyser

A single-page tool that reprices an Azure **Dev/Test subscription's** actual usage at **Azure Plan (CSP) retail rates** and calculates the **partner discount at which moving to CSP becomes cheaper** than staying on Dev/Test rates.

**Everything runs in your browser.** The CSV files you provide are parsed locally with JavaScript and are never uploaded anywhere. The only outbound calls are to the public, unauthenticated [Azure Retail Prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices) when your export lacks a retail comparator column.

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

## How the comparison works

| Step | Calculation |
|---|---|
| Current spend | Sum of usage-charge lines (marketplace and purchase charges excluded — they bill identically on either offer) |
| Retail repricing | `Quantity × PayGPrice` per line, or Retail Prices API lookup by `MeterId` where PayGPrice is absent |
| Windows uplift | Per Windows VM: (Windows rate − Linux rate) for its size/region × consumed compute hours (matched from the export where possible, editable per-VM) |
| CSP cost at *d*% | `(retail + uplift) × (1 − d)` |
| **Break-even** | `1 − current ÷ (retail + uplift)` — the discount above which Azure Plan beats Dev/Test |

Lines with no retail comparator are conservatively treated as having **no Dev/Test discount** (retail = current), so the break-even shown is a floor, not an optimistic estimate.

## What the numbers can't show

- Dev/Test carries **no financially-backed SLA**; Azure Plan restores standard SLAs.
- **Production workloads are prohibited** on Dev/Test offers.
- Dev/Test rates depend on **active Visual Studio subscribers**; CSP removes that dependency.
- **SQL Server VMs** on Dev/Test also bill without the SQL licence meter — if present, the true CSP cost is higher than shown unless AHB covers SQL.
- **Reservations and savings plans** are available on Azure Plan and can improve the CSP case beyond the PAYG comparison used here.

## Deploying

This is a single static `index.html` — enable **GitHub Pages** on the repo (Settings → Pages → Deploy from branch → `main` / root) and share the URL. No build step, no backend.

> **Note on the Retail Prices API:** it is called directly from the browser. If a customer's network blocks it, the tool degrades gracefully — a warning is shown, uncovered lines are treated conservatively, and a manual Windows-uplift override field is available.

## Disclaimer

Estimates only. Validate against a formal CSP quote before contracting. Rates, offers and incentive constructs change; this tool compares consumption economics only and is not licensing advice.
