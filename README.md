# Czech VAT Compliance MCP Server

MCP server for Czech and Slovak VAT compliance. Works with Claude Desktop, Cursor, and any MCP-compatible AI assistant.

## Tools

| Tool | Description |
|------|-------------|
| `lookup_company` | Look up any Czech company by IČO (company ID) via ARES registry |
| `check_unreliable_vat_payer` | Check if a supplier is listed as "nespolehlivý plátce DPH" — paying such a supplier can make you liable for their unpaid VAT under §109 ZDPH |
| `check_bank_accounts` | Get all registered bank accounts for a VAT payer — payments to unregistered accounts create VAT liability |
| `validate_vat_eu` | Validate any EU VAT number (CZ, SK, DE, PL, AT, etc.) via the official VIES system |

## Why This Matters (Czech Law)

Under **§109 of the Czech VAT Act (ZDPH)**, if you pay a VAT-registered supplier:
- to a **bank account not registered** with the Czech Financial Administration, OR
- when the supplier is listed as an **unreliable VAT payer (nespolehlivý plátce)**

...you become **jointly liable** for the supplier's unpaid VAT. This MCP server automates these mandatory checks.

## Installation

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "czech-vat": {
      "command": "npx",
      "args": ["-y", "tsx", "/path/to/czech-vat-mcp/src/index.ts"]
    }
  }
}
```

### Via npx (no install needed)

```json
{
  "mcpServers": {
    "czech-vat": {
      "command": "npx",
      "args": ["-y", "github:YOUR_GITHUB/czech-vat-mcp"]
    }
  }
}
```

## Example Prompts

```
Is company CZ27082440 an unreliable VAT payer?
Look up company with IČO 27082440
What bank accounts can I pay to for supplier CZ27082440?
Validate EU VAT number DE123456789
Check if this supplier is safe to pay: CZ12345678
```

## Data Sources

- **ARES** — Czech Ministry of Finance business registry (ares.gov.cz)
- **Finanční správa ČR** — Czech Financial Administration SOAP API (adisrws.mfcr.cz)
- **VIES** — EU VAT Information Exchange System (ec.europa.eu)

All data sources are official government APIs with no API key required.

## Requirements

- Node.js 18+
- No API keys needed — all data sources are free public government APIs

## License

MIT
