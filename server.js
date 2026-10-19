 "use strict";

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const {
  startPairing,
  startQrPairing,
  cancelPairing,
  getStatus,
} = require("./pairing");

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet({
  contentSecurityPolicy: false, // The supplied frontend uses inline scripts/styles.
  crossOriginEmbedderPolicy: false,
}));
app.use(express.json({ limit: "10kb" }));

const pairLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { ok: false, error: "Too many pairing attempts. Wait 10 minutes and try again." },
});

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, service: "Kiptenden Youths Pairing", status: getStatus().status });
});

app.get("/api/pair/status", (_req, res) => {
  const state = getStatus();
  res.set("Cache-Control", "no-store");
  res.json({
    status: state.status,
    mode: state.mode,
    code: state.code,
    qrDataUrl: state.qrDataUrl,
    sessionId: state.sessionId,
    error: state.error,
  });
});

app.post("/api/pair", pairLimiter, async (req, res) => {
  const phone = String(req.body?.phone || "").replace(/\D/g, "");
  if (phone.length < 7 || phone.length > 15) {
    return res.status(400).json({ ok: false, error: "Enter a valid phone number with country code, digits only." });
  }
  const current = getStatus();
  if (["requesting", "ready", "restarting"].includes(current.status)) {
    return res.status(409).json({ ok: false, error: "A pairing attempt is already running. Cancel it or wait for it to finish." });
  }
  try {
    await startPairing(phone);
    return res.status(202).json({ ok: true });
  } catch (err) {
    console.error("[API] Pair start failed:", err);
    return res.status(500).json({ ok: false, error: "Could not start pairing. Check the service logs and try again." });
  }
});

app.post("/api/pair/qr", pairLimiter, async (_req, res) => {
  const current = getStatus();
  if (["requesting", "ready", "restarting"].includes(current.status)) {
    return res.status(409).json({ ok: false, error: "A pairing attempt is already running. Cancel it or wait for it to finish." });
  }
  try {
    await startQrPairing();
    return res.status(202).json({ ok: true });
  } catch (err) {
    console.error("[API] QR start failed:", err);
    return res.status(500).json({ ok: false, error: "Could not start QR pairing. Check the service logs and try again." });
  }
});

app.post("/api/pair/cancel", (_req, res) => {
  cancelPairing();
  res.json({ ok: true });
});
// Compatibility with the provided page's existing cancellation request.
app.get("/api/pair/cancel", (_req, res) => {
  cancelPairing();
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, "public"), {
  index: "index.html",
  maxAge: process.env.NODE_ENV === "production" ? "1h" : 0,
}));

app.use((_req, res) => res.status(404).send("Not found"));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Kiptenden Youths Pairing site listening on port ${PORT}`);
});
