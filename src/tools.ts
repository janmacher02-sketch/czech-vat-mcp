import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatAddress(sidlo: any): string {
  if (!sidlo) return "Adresa neznámá";
  const parts = [
    sidlo.nazevUlice,
    sidlo.cisloDomovni
      ? `${sidlo.cisloDomovni}${sidlo.cisloOrientacni ? `/${sidlo.cisloOrientacni}` : ""}`
      : null,
    sidlo.nazevObce,
    sidlo.psc ? String(sidlo.psc).replace(/(\d{3})(\d{2})/, "$1 $2") : null,
  ].filter(Boolean);
  return parts.join(", ");
}

const SOAP_URL = "https://adisrws.mfcr.cz/dpr/axis2/services/rozhraniCRPDPH.rozhraniCRPDPHSOAP";
const SOAP_NS  = "http://adis.mfcr.cz/rozhraniCRPDPH/";

async function callSoapVAT(dicNumber: string): Promise<string> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="${SOAP_NS}">
  <soapenv:Header/>
  <soapenv:Body>
    <tns:StatusNespolehlivyPlatceRequest>
      <tns:dic>${dicNumber}</tns:dic>
    </tns:StatusNespolehlivyPlatceRequest>
  </soapenv:Body>
</soapenv:Envelope>`;

  const res = await fetch(SOAP_URL, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8", "SOAPAction": "getStatusNespolehlivyPlatce" },
    body,
  });
  if (!res.ok) throw new Error(`SOAP chyba: ${res.status}`);
  return res.text();
}

function extractAttr(xml: string, attr: string): string {
  const m = xml.match(new RegExp(`${attr}="([^"]+)"`));
  return m ? m[1] : "";
}

// ─── Register all tools on a McpServer instance ───────────────────────────────

export function registerTools(server: McpServer) {

  server.tool(
    "lookup_company",
    "Look up a Czech company in the ARES registry by IČO (company ID). Returns name, address, VAT number, legal form and status.",
    { ico: z.string().describe("IČO (8-digit company ID), e.g. '27082440'") },
    async ({ ico }) => {
      const cleanIco = ico.replace(/\s/g, "").padStart(8, "0");
      const res = await fetch(`https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/${cleanIco}`);
      if (res.status === 404) return { content: [{ type: "text", text: `Company with IČO ${cleanIco} not found in ARES.` }] };
      if (!res.ok) throw new Error(`ARES error: ${res.status}`);
      const d = await res.json() as any;

      let text = `**${d.obchodniJmeno}**\n`;
      text += `IČO: ${d.ico}\n`;
      text += `DIČ (VAT): ${d.dic ?? "Not a VAT payer"}\n`;
      text += `Legal form: ${d.pravniForma?.nazev ?? "—"}\n`;
      text += `Address: ${formatAddress(d.sidlo)}\n`;
      text += `Founded: ${d.datumVzniku ?? "—"}\n`;
      if (d.datumZaniku) text += `Dissolved: ${d.datumZaniku}\n`;
      text += `Status: ${d.stavSubjektu?.nazev ?? "Active"}`;
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "check_unreliable_vat_payer",
    "Check if a Czech company is listed as an 'unreliable VAT payer' (nespolehlivý plátce DPH). If you pay such a supplier, you become jointly liable for their unpaid VAT under §109 ZDPH.",
    { dic: z.string().describe("Czech VAT number including CZ prefix, e.g. 'CZ27082440'") },
    async ({ dic }) => {
      const cleanDic = dic.toUpperCase().replace(/\s/g, "");
      if (!cleanDic.startsWith("CZ")) return { content: [{ type: "text", text: "Only Czech VAT numbers (CZ...) are supported. For other EU countries use validate_vat_eu." }] };

      const xml = await callSoapVAT(cleanDic.replace("CZ", ""));
      const statusCode = extractAttr(xml, "statusCode");
      if (statusCode !== "0") throw new Error(`SOAP error ${statusCode}: ${extractAttr(xml, "statusText")}`);

      const isUnreliable = extractAttr(xml, "nespolehlivyPlatce") === "ANO";
      let text = `**Unreliable VAT Payer Check**\nVAT: ${cleanDic}\nResult: **${isUnreliable ? "⚠️ UNRELIABLE PAYER" : "✅ RELIABLE PAYER"}**\n\n`;
      if (isUnreliable) {
        text += `⚠️ WARNING: This company is listed as an unreliable VAT payer!\nPaying them to an unregistered account, or if they fail to remit VAT, makes you jointly liable.`;
      } else {
        text += `This company is not on the unreliable VAT payer list.`;
      }
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "check_bank_accounts",
    "Get the registered bank accounts of a Czech VAT payer. Payments to unregistered accounts create VAT liability under §109 ZDPH.",
    { dic: z.string().describe("Czech VAT number including CZ prefix, e.g. 'CZ27082440'") },
    async ({ dic }) => {
      const cleanDic = dic.toUpperCase().replace(/\s/g, "");
      const xml = await callSoapVAT(cleanDic.replace("CZ", ""));
      const statusCode = extractAttr(xml, "statusCode");
      if (statusCode !== "0") throw new Error(`SOAP error ${statusCode}`);

      const standardni: string[] = [];
      for (const m of xml.matchAll(/<standardniUcet[^>]*(?:predcisli="(\d+)"[^>]*)?\s*cislo="(\d+)"\s*kodBanky="(\d+)"/g)) {
        standardni.push(`${m[1] ? m[1] + "-" : ""}${m[2]}/${m[3]}`);
      }
      const nestandardni: string[] = [];
      for (const m of xml.matchAll(/<nestandardniUcet[^>]*cislo="([^"]+)"/g)) nestandardni.push(m[1]);

      let text = `**Registered Bank Accounts (VAT)**\nVAT: ${cleanDic}\n\n`;
      if (standardni.length > 0 || nestandardni.length > 0) {
        if (standardni.length) { text += `Czech accounts:\n`; standardni.forEach(a => text += `• ${a}\n`); }
        if (nestandardni.length) { text += `\nIBAN / foreign accounts:\n`; nestandardni.forEach(a => text += `• ${a}\n`); }
        text += `\n⚠️ Only pay to these accounts. Paying to any other account = risk of VAT liability.`;
      } else {
        text += `No registered accounts found (company may not be a VAT payer).`;
      }
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "validate_vat_eu",
    "Validate any EU VAT number via the official VIES system. Works for all EU member states: CZ, SK, DE, PL, AT, etc.",
    {
      country_code: z.string().length(2).describe("2-letter country code, e.g. 'CZ', 'SK', 'DE', 'PL'"),
      vat_number: z.string().describe("VAT number WITHOUT country prefix, e.g. '27082440' (not 'CZ27082440')"),
    },
    async ({ country_code, vat_number }) => {
      const country = country_code.toUpperCase();
      const vat = vat_number.replace(/\s/g, "");
      const res = await fetch(`https://ec.europa.eu/taxation_customs/vies/rest-api/ms/${country}/vat/${vat}`);
      if (!res.ok) throw new Error(`VIES error: ${res.status}`);
      const d = await res.json() as any;

      let text = `**VIES VAT Validation**\nVAT: ${country}${vat}\nValid: **${d.isValid ? "✅ YES" : "❌ NO"}**\n`;
      if (d.isValid) {
        if (d.name && d.name !== "---") text += `Name: ${d.name}\n`;
        if (d.address && d.address !== "---") text += `Address: ${d.address}\n`;
      } else {
        text += `\nThis VAT number is not registered in VIES or is invalid.`;
      }
      text += `\nSource: EU VIES (${new Date().toISOString().split("T")[0]})`;
      return { content: [{ type: "text", text }] };
    }
  );
}
