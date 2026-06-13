// DrumCoach static server.
//
// The app itself runs entirely in the browser (it needs the Web Audio API and
// microphone access, which are browser-only). This server's only job is to
// serve the client over HTTP so the browser will grant mic permission on a
// proper origin rather than a file:// URL.

import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ?? 3000;

const app = express();

// Serve the client.
app.use(express.static(join(__dirname, "public")));

// Tiny health endpoint, handy when scripting/CI.
app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`🥁 DrumCoach running at http://localhost:${PORT}`);
  console.log("   Open it in Chrome/Edge and allow microphone access.");
});
