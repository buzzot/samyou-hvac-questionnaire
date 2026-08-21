/**
 * Samyou USA — HVAC Requirement Questionnaire
 * Single Node service (zero dependencies) for Railway.
 *
 *   • Serves the static questionnaire from /public
 *   • POST /api/submit  →  saves to Supabase + emails you via Mailgun
 *
 * All secrets come from environment variables (set them in Railway → Variables).
 * Nothing sensitive lives in the code or is ever sent to the browser.
 */

import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = process.env.PORT || 3000;

/* ----------------- config from environment ----------------- */
const CFG = {
  supabase: {
    url: process.env.SUPABASE_URL || "",
    key: process.env.SUPABASE_SERVICE_KEY || "",
    table: process.env.SUPABASE_TABLE || "hvac_submissions",
  },
  mailgun: {
    key: process.env.MAILGUN_API_KEY || "",
    domain: process.env.MAILGUN_DOMAIN || "",
    region: (process.env.MAILGUN_REGION || "us").toLowerCase(),
    from: process.env.MAIL_FROM || "HVAC Requests <requests@example.com>",
    to: process.env.MAIL_TO || "",
    replyToSubmitter: (process.env.MAIL_REPLY_TO_SUBMITTER || "true") === "true",
  },
  // Optional: comma-separated list of origins allowed to POST cross-origin.
  // Leave empty when the page is served by THIS app (same-origin) — the default.
  allowedOrigins: (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean),
  // Password for the /admin page. Set ADMIN_PASSWORD in Railway. If empty, /admin is disabled.
  adminPassword: process.env.ADMIN_PASSWORD || "",
};

/* ----------------- admin auth + data ----------------- */
function checkAdmin(req) {
  if (!CFG.adminPassword) return false;
  const given = req.headers["x-admin-password"] || "";
  const a = Buffer.from(String(given));
  const b = Buffer.from(CFG.adminPassword);
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}
async function listSubmissions() {
  if (!CFG.supabase.url || !CFG.supabase.key) throw new Error("Supabase not configured");
  const url = `${CFG.supabase.url.replace(/\/$/,"")}/rest/v1/${encodeURIComponent(CFG.supabase.table)}?select=*&order=submitted_at.desc&limit=2000`;
  const r = await fetch(url, { headers: { apikey: CFG.supabase.key, Authorization: `Bearer ${CFG.supabase.key}` } });
  if (!r.ok) throw new Error(`supabase http ${r.status}: ${(await r.text()).slice(0,200)}`);
  return r.json();
}

/* ----------------- helpers ----------------- */
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".json": "application/json",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};
const val = (data, k) => Array.isArray(data[k]) ? data[k].join(", ") : String(data[k] ?? "");
function json(res, code, obj, extraHeaders = {}) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff", ...extraHeaders });
  res.end(JSON.stringify(obj));
}
function corsHeaders(req) {
  const origin = req.headers.origin;
  if (origin && CFG.allowedOrigins.includes(origin)) {
    return { "Access-Control-Allow-Origin": origin, "Vary": "Origin", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
  }
  return {};
}

/* ----------------- static file serving ----------------- */
async function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url.split("?")[0]) || "/");
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end("Forbidden"); }
  try {
    const s = await stat(filePath);
    if (s.isDirectory()) throw new Error("dir");
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Content-Length": s.size });
    createReadStream(filePath).pipe(res);
  } catch {
    // SPA-style fallback to index.html for unknown non-file routes
    try {
      const html = await readFile(path.join(PUBLIC_DIR, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch {
      res.writeHead(404); res.end("Not found");
    }
  }
}

/* ----------------- read + limit request body ----------------- */
function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > limit) { reject(new Error("payload too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/* ----------------- build the notification email ----------------- */
const LABELS = {
  projectName:"Project name",customerName:"Contact name",company:"Company",email:"Email",phone:"Phone",country:"Country / region",
  salesTerritory:"Sales territory",annualDemand1:"Annual demand Y1",annualDemand2:"Annual demand Y2",annualDemand3:"Annual demand Y3",
  modelSpecification:"Model / specification",capacities:"Capacity options",otherCapacity:"Other capacity",climate:"Climate",speedType:"Compressor control",
  constructionType:"Construction",operatingMode:"Operating mode",sourceType:"Source type",description:"Project description",developmentScope:"Development scope",
  voltage:"Voltage",phase:"Phase",frequency:"Frequency",refrigerant:"Refrigerant",otherRefrigerant:"Other refrigerant",referenceStandard:"Reference standard",
  coolingCapacity:"Cooling capacity",heatingCapacity:"Heating capacity",capacityTolerance:"Capacity tolerance",efficiencyMetrics:"Efficiency target",
  efficiencyTolerance:"Efficiency tolerance",sampleCapacity:"Test-sample capacity",sampleEfficiency:"Test-sample efficiency",iduHeatingRange:"IDU heating range",
  iduCoolingRange:"IDU cooling range",oduHeatingRange:"ODU heating range",oduCoolingRange:"ODU cooling range",connectionPipe:"Test connection piping",
  noiseStandard:"Noise standard",iduNoise:"Max IDU noise",oduNoise:"Max ODU noise",specialRequirements:"Special performance requirements",certifications:"Certifications",
  otherCertification:"Other certification",certificationMethod:"Certification method",exportEnergyLabel:"Export energy label",rohs:"RoHS",weee:"WEEE",reach:"REACH",
  otherHazardous:"Other hazardous-substance restrictions",displayFormat:"Display format",temperatureUnit:"Temperature unit",coldPlasma:"Cold plasma",
  horizontalSwing:"Horizontal swing",standbyPower:"Standby power",temperatureResolution:"Temperature resolution",powerConfiguration:"Power configuration",
  electrostaticCleaner:"Electrostatic cleaner",pm25Filter:"PM2.5 filter",wifi:"Wi-Fi",wiredController:"Wired controller",thermostat:"24 V thermostat",
  testMode:"Test-mode entry",plugType:"Plug type",basePanHeater:"Base-pan heater",crankcaseHeater:"Crankcase heater",windingPreheat:"Winding preheat",
  auxiliaryHeater:"Auxiliary heater",auxiliaryHeaterDetails:"Auxiliary heater details",electricalNotes:"Other electrical requirements",compressorBrand:"Compressor brand",
  compressorModel:"Compressor model",iduMotorType:"IDU fan motor type",iduMotorBrand:"IDU fan motor brand",oduMotorType:"ODU fan motor type",oduMotorBrand:"ODU fan motor brand",
  sensorLogic:"Sensor logic",expansionDevice:"Expansion device",heatExchanger:"Heat exchanger",customerTests:"Customer tests",samyouTests:"SAMYOU tests",finalNotes:"Final notes",
};
const escapeHtml = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
function buildEmail(data, id, submittedAt) {
  const textLines = ["New HVAC development requirement submission", `Submission ID: ${id}`, `Submitted: ${submittedAt} UTC`, "-".repeat(48)];
  let htmlRows = "";
  for (const [k, label] of Object.entries(LABELS)) {
    const v = val(data, k); if (v === "") continue;
    textLines.push(`${label}: ${v}`);
    htmlRows += `<tr><td style="padding:6px 12px;border-bottom:1px solid #eee;color:#76767f;font-size:12px;white-space:nowrap;vertical-align:top">${escapeHtml(label)}</td><td style="padding:6px 12px;border-bottom:1px solid #eee;color:#26262c;font-size:13px">${escapeHtml(v).replace(/\n/g,"<br>")}</td></tr>`;
  }
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:640px">`
    + `<div style="background:#26262c;color:#fff;padding:18px 20px"><div style="color:#bc132e;font-size:11px;font-weight:bold;letter-spacing:2px">SAMYOU USA · ENGINEERING REQUEST</div>`
    + `<div style="font-size:18px;font-weight:bold;margin-top:4px">New HVAC Requirement Submission</div></div>`
    + `<div style="padding:16px 20px;background:#f6f7fd;color:#26262c;font-size:13px"><strong>${escapeHtml(id)}</strong> · ${escapeHtml(submittedAt)} UTC</div>`
    + `<table style="border-collapse:collapse;width:100%">${htmlRows}</table>`
    + `<div style="padding:14px 20px;color:#8c9299;font-size:11px">Sent automatically from requirements.samyouusa.com</div></div>`;
  return { text: textLines.join("\n"), html, subject: `HVAC request — ${val(data,"company")} — ${val(data,"projectName")} (${id})` };
}

/* ----------------- Supabase insert ----------------- */
async function saveToSupabase(data, id, submittedAt) {
  if (!CFG.supabase.url || !CFG.supabase.key) { console.log(`[db ${id}] SKIPPED — missing ${[!CFG.supabase.url&&"SUPABASE_URL",!CFG.supabase.key&&"SUPABASE_SERVICE_KEY"].filter(Boolean).join(", ")}`); return; }
  let capacities = val(data, "capacities");
  if (val(data, "otherCapacity")) capacities = [capacities, val(data, "otherCapacity")].filter(Boolean).join(", ");
  let refrigerant = val(data, "refrigerant");
  if (refrigerant === "Other" && val(data, "otherRefrigerant")) refrigerant = "Other: " + val(data, "otherRefrigerant");
  const demand = [val(data,"annualDemand1"), val(data,"annualDemand2"), val(data,"annualDemand3")].filter(Boolean).join(" / ");
  const row = {
    submission_id: id, submitted_at: submittedAt,
    project_name: val(data,"projectName"), contact_name: val(data,"customerName"), company: val(data,"company"),
    email: val(data,"email"), phone: val(data,"phone"), country: val(data,"country"), sales_territory: val(data,"salesTerritory"),
    capacities, construction: val(data,"constructionType"), operating_mode: val(data,"operatingMode"),
    refrigerant, certifications: val(data,"certifications"), annual_demand: demand, status: "New", data,
  };
  const r = await fetch(`${CFG.supabase.url.replace(/\/$/,"")}/rest/v1/${encodeURIComponent(CFG.supabase.table)}`, {
    method: "POST",
    headers: { apikey: CFG.supabase.key, Authorization: `Bearer ${CFG.supabase.key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`supabase http ${r.status}: ${(await r.text()).slice(0,300)}`);
  console.log(`[db ${id}] inserted`);
}

/* ----------------- Mailgun send ----------------- */
async function sendEmail(data, id, submittedAt) {
  const mg = CFG.mailgun;
  if (!mg.key || !mg.domain || !mg.to) {
    console.log(`[mail ${id}] SKIPPED — missing ${[!mg.key&&"MAILGUN_API_KEY",!mg.domain&&"MAILGUN_DOMAIN",!mg.to&&"MAIL_TO"].filter(Boolean).join(", ")}`);
    return;
  }
  const { text, html, subject } = buildEmail(data, id, submittedAt);
  const host = mg.region === "eu" ? "https://api.eu.mailgun.net" : "https://api.mailgun.net";
  const form = new URLSearchParams({ from: mg.from, to: mg.to, subject, text, html });
  if (mg.replyToSubmitter && /.+@.+/.test(String(data.email))) form.set("h:Reply-To", String(data.email));
  const auth = Buffer.from(`api:${mg.key}`).toString("base64");
  const r = await fetch(`${host}/v3/${encodeURIComponent(mg.domain)}/messages`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`mailgun http ${r.status}: ${body.slice(0,300)}`);
  console.log(`[mail ${id}] ACCEPTED by Mailgun (${r.status}) via ${host}/${mg.domain} → ${mg.to} :: ${body.slice(0,140)}`);
}

/* ----------------- submission handler ----------------- */
async function handleSubmit(req, res) {
  const cors = corsHeaders(req);
  let data;
  try { data = JSON.parse(await readBody(req)); }
  catch { return json(res, 400, { error: "Invalid request payload." }, cors); }
  if (!data || typeof data !== "object") return json(res, 400, { error: "Invalid request payload." }, cors);

  // Honeypot — bots fill the hidden "website" field.
  if (data.website) return json(res, 200, { ok: true, id: "accepted" }, cors);

  for (const key of ["projectName", "customerName", "company", "email", "country"]) {
    if (!data[key] || typeof data[key] !== "string") return json(res, 400, { error: `Missing required field: ${key}` }, cors);
  }
  if (!String(data.email).includes("@")) return json(res, 400, { error: "Please provide a valid email address." }, cors);

  const id = `HVAC-${new Date().toISOString().slice(0,10).replaceAll("-","")}-${crypto.randomUUID().slice(0,8).toUpperCase()}`;
  const submittedAt = new Date().toISOString();

  // Run both; collect errors but still return the id so the visitor gets their Excel.
  const results = await Promise.allSettled([saveToSupabase(data, id, submittedAt), sendEmail(data, id, submittedAt)]);
  const errors = results.filter(r => r.status === "rejected").map(r => String(r.reason && r.reason.message || r.reason));
  if (errors.length) console.error(`[submit ${id}]`, errors.join(" | "));
  else console.log(`[submit ${id}] ${val(data,"company")} — ${val(data,"projectName")}`);

  return json(res, 200, { ok: true, id }, cors);
}

/* ----------------- router ----------------- */
const server = http.createServer(async (req, res) => {
  try {
    const pathname = (req.url || "/").split("?")[0];
    if (pathname === "/healthz") return json(res, 200, { ok: true });
    if (pathname === "/api/submit") {
      if (req.method === "OPTIONS") { res.writeHead(204, corsHeaders(req)); return res.end(); }
      if (req.method === "POST") return handleSubmit(req, res);
      return json(res, 405, { error: "Method not allowed." });
    }
    if (pathname === "/admin") {
      const file = path.join(PUBLIC_DIR, "admin.html");
      try { const html = await readFile(file); res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(html); }
      catch { res.writeHead(404); return res.end("Not found"); }
    }
    if (pathname === "/api/admin/list") {
      if (req.method !== "POST") return json(res, 405, { error: "Method not allowed." });
      if (!CFG.adminPassword) return json(res, 500, { error: "Admin is not configured (set ADMIN_PASSWORD)." });
      if (!checkAdmin(req)) return json(res, 401, { error: "Incorrect password." });
      try { return json(res, 200, { rows: await listSubmissions() }); }
      catch (e) { return json(res, 500, { error: String(e.message || e) }); }
    }
    if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res);
    res.writeHead(405); res.end("Method not allowed");
  } catch (e) {
    console.error("server error:", e);
    if (!res.headersSent) json(res, 500, { error: "Server error." });
  }
});

server.listen(PORT, () => console.log(`Samyou HVAC questionnaire running on :${PORT}`));
