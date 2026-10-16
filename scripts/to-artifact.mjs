// Turns the single-file Vite build into the page fragment the claude.ai
// Artifact host expects (it supplies its own <html>/<head>/<body> skeleton).
import { readFileSync, writeFileSync } from "node:fs";

const html = readFileSync("dist-single/index.html", "utf8");
const grab = (re) => [...html.matchAll(re)].map((m) => m[0]).join("\n");

const title = grab(/<title>[\s\S]*?<\/title>/g);
const metas = grab(/<meta name="claude:[^>]*>/g);
const fonts = grab(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>/g);
const styles = grab(/<style[^>]*>[\s\S]*?<\/style>/g);
const scripts = grab(/<script type="module"[^>]*>[\s\S]*?<\/script>/g);

const out = [title, metas, fonts, styles, '<div id="root"></div>', scripts].join("\n");
writeFileSync("dist-single/workradar.html", out);
console.log(`wrote dist-single/workradar.html (${(out.length / 1024).toFixed(0)} KB)`);
