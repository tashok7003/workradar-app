import { createApp } from "./app";
import { loadConfig } from "./config";

// Load .env when present (Node 20.6+), without adding a dependency.
try { process.loadEnvFile?.(); } catch { /* no .env file: rely on the real environment */ }

const cfg = loadConfig();
createApp(cfg).listen(cfg.port, () => {
  console.log(`WorkRadar API on http://localhost:${cfg.port}`);
  console.log(`  AI:     ${cfg.gemini ? `Gemini (${cfg.gemini.model})` : "off (set GEMINI_API_KEY)"}`);
  console.log(`  GitHub: ${cfg.github ? cfg.github.repos.join(", ") + (cfg.github.token ? "" : " (no token: 60 requests/hour)") : "off (set GITHUB_REPOS)"}`);
});
