const supabaseVariables = [
  "SUPABASE_URL",
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_ANON_KEY",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
];

const envValues = Object.fromEntries(
  supabaseVariables.map((name) => [name, process.env[name] ?? ""]),
);

function printFailure(message) {
  console.log(`FAIL: ${message}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeError(error) {
  let message = error instanceof Error ? error.message : "Request failed";

  for (const value of Object.values(envValues).filter(Boolean)) {
    message = message.replace(new RegExp(escapeRegExp(value), "g"), "[redacted]");
  }

  return message
    .replace(/\bsb_(?:publishable|secret)_[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/https?:\/\/\S+/g, "[URL]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 240);
}

try {
  if (typeof process.loadEnvFile !== "function") {
    printFailure("Node.js process.loadEnvFile() is unavailable; use Node.js 20.12 or newer");
    process.exit(1);
  }

  process.loadEnvFile();
} catch (error) {
  if (error?.code !== "ENOENT") {
    printFailure("Unable to load .env");
    process.exit(1);
  }
}

for (const name of supabaseVariables) {
  envValues[name] = process.env[name] ?? "";
  console.log(`${name}: ${envValues[name] ? "set" : "MISSING"}`);
}

const secretKey = envValues.SUPABASE_SERVICE_ROLE_KEY;
console.log(`SUPABASE_SERVICE_ROLE_KEY new format: ${secretKey.startsWith("sb_secret_")}`);

for (const [name, value] of Object.entries(envValues)) {
  if (/^[^\s.]+\.[^\s.]+\.[^\s.]+$/.test(value) && value.length > 100) {
    console.log(`WARNING: legacy JWT-style key still in use in ${name}`);
  }
}

const supabaseUrl = envValues.VITE_SUPABASE_URL || envValues.SUPABASE_URL;
const publishableKey = envValues.VITE_SUPABASE_ANON_KEY || envValues.SUPABASE_ANON_KEY;

async function checkRequest(label, table, query, key, options = {}) {
  if (!supabaseUrl || !key) {
    printFailure(`${label}: required URL or key is MISSING`);
    return false;
  }

  try {
    const url = new URL(`/rest/v1/${table}?${query}`, supabaseUrl);
    const headers = new Headers(options.headers);
    headers.set("apikey", key);
    if (/^[^\s.]+\.[^\s.]+\.[^\s.]+$/.test(key) && key.length > 100) {
      headers.set("Authorization", `Bearer ${key}`);
    }

    const response = await fetch(url, { ...options, headers });
    if (!response.ok) {
      console.log(`FAIL: ${label}: HTTP ${response.status}`);
      return false;
    }

    console.log(`PASS: ${label}`);
    return true;
  } catch (error) {
    printFailure(`${label}: ${sanitizeError(error)}`);
    return false;
  }
}

const publicRequest = checkRequest(
  "publishable key connectivity",
  "menu_items",
  "select=id&limit=1",
  publishableKey,
);
const secretRequest = checkRequest(
  "secret key connectivity",
  "restaurants",
  "select=id",
  secretKey,
  { method: "HEAD", headers: { Prefer: "count=exact", Range: "0-0" } },
);

const results = await Promise.all([publicRequest, secretRequest]);
if (results.some((passed) => !passed)) process.exitCode = 1;
