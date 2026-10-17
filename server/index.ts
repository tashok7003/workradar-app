import { createApp } from "./app";
import { loadConfig } from "./config";

// Load .env when present (Node 20.12+), without adding a dependency.
if (typeof process.loadEnvFile !== "function") {
  console.warn("Node", process.version, "can't read .env files. Upgrade to Node 20.12 or newer, or export the variables in your shell.");
} else {
  try { process.loadEnvFile(); } catch { console.warn("No .env file found: copy .env.example to .env and fill it in."); }
}

const cfg = loadConfig();
createApp(cfg).listen(cfg.port, () => {
  console.log(`WorkRadar API on http://localhost:${cfg.port}`);
  console.log(`  AI:     ${cfg.gemini ? `Gemini (${cfg.gemini.model})` : "off (set GEMINI_API_KEY)"}`);
  console.log(`  Google: ${cfg.google ? `ready (redirect ${cfg.google.redirectUri})` : "off (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET for Calendar and Tasks)"}`);
  console.log(`  Sources: add and manage them at ${cfg.publicUrl} → Sources`);
});
