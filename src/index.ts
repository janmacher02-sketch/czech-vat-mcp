import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "czech-vat-mcp",
  version: "1.0.0",
});

// ─── Helper ───────────────────────────────────────────────────────────────────

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

// ─── Nástroj 1: ARES – vyhledání firmy ───────────────────────────────────────

server.tool(
  "lookup_company",
  "Vyhledá firmu v ARES (Administrativní registr ekonomických subjektů) podle IČO. Vrátí název, adresu, DIČ, právní formu a stav subjektu.",
  {
    ico: z.string().describe("IČO firmy (8 číslic), např. '27082440' nebo '27 08 24 40'"),
  },
  async ({ ico }) => {
    const cleanIco = ico.replace(/\s/g, "").padStart(8, "0");

    const res = await fetch(
      `https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/${cleanIco}`
    );

    if (res.status === 404) {
      return {
        content: [{ type: "text", text: `Firma s IČO ${cleanIco} nebyla nalezena v ARES.` }],
      };
    }
    if (!res.ok) throw new Error(`ARES chyba: ${res.status}`);

    const d = (await res.json()) as any;

    let text = `**${d.obchodniJmeno}**\n`;
    text += `IČO: ${d.ico}\n`;
    text += `DIČ: ${d.dic ?? "Není plátce DPH"}\n`;
    text += `Právní forma: ${d.pravniForma?.nazev ?? "—"}\n`;
    text += `Adresa: ${formatAddress(d.sidlo)}\n`;
    text += `Vznik: ${d.datumVzniku ?? "—"}\n`;
    if (d.datumZaniku) text += `Zánik: ${d.datumZaniku}\n`;
    text += `Stav: ${d.stavSubjektu?.nazev ?? "—"}`;

    return { content: [{ type: "text", text }] };
  }
);

// ─── Helper: SOAP volání Finanční správy ─────────────────────────────────────

const SOAP_URL = "https://adisrws.mfcr.cz/dpr/axis2/services/rozhraniCRPDPH.rozhraniCRPDPHSOAP";
const SOAP_NS = "http://adis.mfcr.cz/rozhraniCRPDPH/";

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
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      "SOAPAction": "getStatusNespolehlivyPlatce",
    },
    body,
  });

  if (!res.ok) throw new Error(`SOAP chyba: ${res.status}`);
  return res.text();
}

function extractAttr(xml: string, attr: string): string {
  const m = xml.match(new RegExp(`${attr}="([^"]+)"`));
  return m ? m[1] : "";
}

// ─── Nástroj 2: Nespolehlivý plátce DPH ──────────────────────────────────────

server.tool(
  "check_unreliable_vat_payer",
  "Zkontroluje zda je firma vedena jako 'nespolehlivý plátce DPH' na Finanční správě ČR. Pokud zaplatíš nespolehlivému plátci, stáváš se ručitelem za jeho neodvedené DPH.",
  {
    dic: z.string().describe("DIČ firmy včetně předpony CZ, např. 'CZ27082440'"),
  },
  async ({ dic }) => {
    const cleanDic = dic.toUpperCase().replace(/\s/g, "");
    if (!cleanDic.startsWith("CZ")) {
      return {
        content: [{ type: "text", text: "Pouze česká DIČ (CZ...). Pro EU použij validate_vat_eu." }],
      };
    }

    const dicNumber = cleanDic.replace("CZ", "");
    const xml = await callSoapVAT(dicNumber);

    const statusCode = extractAttr(xml, "statusCode");
    if (statusCode !== "0") {
      const statusText = extractAttr(xml, "statusText");
      throw new Error(`SOAP statusCode=${statusCode}: ${statusText}`);
    }

    const nespolehlivy = extractAttr(xml, "nespolehlivyPlatce");
    const isUnreliable = nespolehlivy === "ANO";

    let text = `**Kontrola nespolehlivého plátce DPH**\n`;
    text += `DIČ: ${cleanDic}\n`;
    text += `Výsledek: **${isUnreliable ? "NESPOLEHLIVÝ PLÁTCE ⚠️" : "SPOLEHLIVÝ PLÁTCE ✅"}**\n\n`;

    if (isUnreliable) {
      const dateMatch = xml.match(/datumZverejneniNespolehlivosti="([^"]+)"/);
      if (dateMatch) text += `Datum zveřejnění: ${dateMatch[1]}\n\n`;
      text += `⚠️ VAROVÁNÍ: Tato firma je vedena jako nespolehlivý plátce!\n`;
      text += `Pokud uhradíš fakturu na jiný než registrovaný účet, nebo dodavatel DPH neodvede, ručíš za toto DPH ty.`;
    } else {
      text += `Firma není na seznamu nespolehlivých plátců DPH.`;
    }

    return { content: [{ type: "text", text }] };
  }
);

// ─── Nástroj 3: Registr bankovních účtů ──────────────────────────────────────

server.tool(
  "check_bank_accounts",
  "Zobrazí registrované bankovní účty plátce DPH. Platby na NEregistrované účty mohou vést k ručení za DPH.",
  {
    dic: z.string().describe("DIČ firmy včetně předpony CZ, např. 'CZ27082440'"),
  },
  async ({ dic }) => {
    const cleanDic = dic.toUpperCase().replace(/\s/g, "");
    const dicNumber = cleanDic.replace("CZ", "");

    const xml = await callSoapVAT(dicNumber);

    const statusCode = extractAttr(xml, "statusCode");
    if (statusCode !== "0") throw new Error(`SOAP statusCode=${statusCode}`);

    // Parsuj standardní účty: předčíslí-číslo/kód
    const standardni: string[] = [];
    const stdMatches = xml.matchAll(/<standardniUcet[^>]*(?:predcisli="(\d+)"[^>]*)?\s*cislo="(\d+)"\s*kodBanky="(\d+)"/g);
    for (const m of stdMatches) {
      const predcisli = m[1] ? `${m[1]}-` : "";
      standardni.push(`${predcisli}${m[2]}/${m[3]}`);
    }

    // Parsuj nestandardní účty (IBAN, zahraniční)
    const nestandardni: string[] = [];
    const nestdMatches = xml.matchAll(/<nestandardniUcet[^>]*cislo="([^"]+)"/g);
    for (const m of nestdMatches) nestandardni.push(m[1]);

    let text = `**Registrované bankovní účty pro DPH**\n`;
    text += `DIČ: ${cleanDic}\n\n`;

    if (standardni.length > 0 || nestandardni.length > 0) {
      if (standardni.length > 0) {
        text += `České účty:\n`;
        standardni.forEach((a) => (text += `• ${a}\n`));
      }
      if (nestandardni.length > 0) {
        text += `\nZahraniční / IBAN účty:\n`;
        nestandardni.forEach((a) => (text += `• ${a}\n`));
      }
      text += `\n⚠️ Platby za plnění s DPH zasílej POUZE na tyto účty. Platba na jiný účet = riziko ručení.`;
    } else {
      text += `Žádné registrované účty nenalezeny (firma nemusí být plátcem DPH).`;
    }

    return { content: [{ type: "text", text }] };
  }
);

// ─── Nástroj 4: VIES – ověření EU DIČ ────────────────────────────────────────

server.tool(
  "validate_vat_eu",
  "Ověří platnost DIČ v systému VIES (EU VAT Information Exchange System). Funguje pro všechny členské státy EU: CZ, SK, DE, PL, AT atd.",
  {
    country_code: z
      .string()
      .length(2)
      .describe("Kód státu (2 písmena), např. 'CZ', 'SK', 'DE', 'PL'"),
    vat_number: z
      .string()
      .describe("DIČ BEZ kódu státu, např. '27082440' (bez 'CZ')"),
  },
  async ({ country_code, vat_number }) => {
    const country = country_code.toUpperCase();
    const vat = vat_number.replace(/\s/g, "");

    const res = await fetch(
      `https://ec.europa.eu/taxation_customs/vies/rest-api/ms/${country}/vat/${vat}`
    );

    if (!res.ok) throw new Error(`VIES chyba: ${res.status}`);

    const d = (await res.json()) as any;

    let text = `**VIES Ověření DIČ**\n`;
    text += `DIČ: ${country}${vat}\n`;
    text += `Platné: **${d.isValid ? "✅ ANO" : "❌ NE"}**\n`;

    if (d.isValid) {
      if (d.name && d.name !== "---") text += `Název: ${d.name}\n`;
      if (d.address && d.address !== "---") text += `Adresa: ${d.address}\n`;
    } else {
      text += `\nToto DIČ není registrováno v VIES nebo je neplatné.`;
    }

    text += `\nZdroj: EU VIES (${new Date().toLocaleDateString("cs-CZ")})`;

    return { content: [{ type: "text", text }] };
  }
);

// ─── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
