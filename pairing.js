// ════════════════════════════════════════════════════════════════════════════
//  KIPTENDEN PAIRING — Generate a new SESSION_ID via WhatsApp pair code or QR
// ════════════════════════════════════════════════════════════════════════════

"use strict";

const {
    default: makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,
    useMultiFileAuthState,
} = require("@whiskeysockets/baileys");
const path = require("path");
const fs = require("fs-extra");
const zlib = require("zlib");
const pino = require("pino");
const QRCode = require("qrcode");

const TEMP_DIR = path.join(__dirname, "pairing_temp");
const SESSION_PREFIX = "KIPTENDEN~";
const MAX_RESTARTS = 3;
const SOCKET_RESTART_DELAY_MS = 0;

let _socket = null;
let _code = null;
let _qrDataUrl = null;
let _sessionId = null;
let _status = "idle"; // idle | requesting | ready | restarting | success | error
let _mode = null;      // code | qr
let _error = null;
let _attempt = 0;

function getStatus() {
    return {
        status: _status,
        mode: _mode,
        code: _code,
        qrDataUrl: _qrDataUrl,
        sessionId: _sessionId,
        error: _error,
    };
}

function _isCurrent(attempt) {
    return attempt === _attempt;
}

function _statusCode(update) {
    return update?.lastDisconnect?.error?.output?.statusCode;
}

function _disconnectReason(update) {
    const error = update?.lastDisconnect?.error;
    const statusCode = _statusCode(update);
    const message = error?.output?.payload?.message || error?.message || "unknown WhatsApp socket error";
    return `${message}${statusCode ? `; status ${statusCode}` : ""}`;
}

function _safeClose(socket) {
    if (!socket) return;
    try { socket.end(undefined); } catch (_) {}
}

function _cleanup() {
    const socket = _socket;
    _socket = null;
    _safeClose(socket);
    try { fs.removeSync(TEMP_DIR); } catch (_) {}
}

function _reset() {
    _attempt += 1;
    _cleanup();
    _code = null;
    _qrDataUrl = null;
    _sessionId = null;
    _mode = null;
    _error = null;
    _status = "idle";
}

function _delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function _ownJid(state, phone) {
    const me = state?.creds?.me?.id;
    if (me) {
        const [user, server = "s.whatsapp.net"] = String(me).split("@");
        return `${user.split(":")[0]}@${server}`;
    }
    return phone ? `${phone}@s.whatsapp.net` : null;
}

async function _sendSessionToSelf(socket, state, phone, sessionId, mode, attempt) {
    const jid = _ownJid(state, phone);
    if (!jid || !sessionId) {
        console.warn(`[PAIR] ${mode} session DM skipped: own WhatsApp JID is unavailable`);
        return;
    }

    const text = [
        "*SESSION ID ✅*",
        "",
        sessionId,
        "> *ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴋɪᴘᴛᴇɴᴅᴇɴ ʏᴏᴜᴛʜs*",
    ].join("\n");

    try {
        await socket.sendMessage(jid, { text });
        console.log(`[PAIR] ${mode} SESSION_ID sent to the paired number's self-DM (attempt ${attempt})`);
    } catch (error) {
        console.error(`[PAIR] ${mode} SESSION_ID self-DM failed (attempt ${attempt}): ${error?.stack || error}`);
    }
}

async function _start(mode, rawPhone = "") {
    _reset();
    const attempt = _attempt;
    const phone = String(rawPhone || "").replace(/\D/g, "");

    if (mode === "code" && (!phone || phone.length < 7)) {
        _status = "error";
        _mode = "code";
        _error = "Invalid phone number.";
        return;
    }

    _mode = mode;
    _status = "requesting";
    fs.ensureDirSync(TEMP_DIR);

    let version;
    try {
        ({ version } = await fetchLatestBaileysVersion());
    } catch (error) {
        _status = "error";
        _error = `Unable to load WhatsApp Web version: ${error.message}`;
        _cleanup();
        return;
    }

    let pairingRequested = false;
    let paired = false;
    let restartCount = 0;

    const fail = (message, error) => {
        if (!_isCurrent(attempt)) return;
        _status = "error";
        _error = message;
        console.error(`[PAIR] ${mode} pairing failed (attempt ${attempt}): ${error?.stack || message}`);
        setTimeout(() => {
            if (_isCurrent(attempt) && _status === "error") _cleanup();
        }, 500);
    };

    const encodeSession = async (socket, state, saveCreds) => {
        if (!_isCurrent(attempt) || _status === "success") return;
        await saveCreds();
        await _delay(250);
        if (!_isCurrent(attempt)) return;

        const credsPath = path.join(TEMP_DIR, "creds.json");
        const credsJson = fs.readFileSync(credsPath, "utf8");
        const compressed = zlib.gzipSync(Buffer.from(credsJson, "utf8"));
        _sessionId = SESSION_PREFIX + compressed.toString("base64");
        await _sendSessionToSelf(socket, state, phone, _sessionId, mode, attempt);
        _status = "success";
        console.log(`[PAIR] ${mode} pairing completed (attempt ${attempt})`);

        setTimeout(() => {
            if (_isCurrent(attempt)) _cleanup();
        }, 5_000);
    };

    const startSocket = async () => {
        if (!_isCurrent(attempt)) return;

        const auth = await useMultiFileAuthState(TEMP_DIR);
        const { state, saveCreds } = auth;
        const silentLogger = pino({ level: "silent" });
        const socket = makeWASocket({
            version,
            auth: state,
            logger: silentLogger,
            browser: ["Mac OS", "Safari", "17.5"],
            printQRInTerminal: false,
            connectTimeoutMs: 60_000,
            defaultQueryTimeoutMs: 30_000,
            keepAliveIntervalMs: 25_000,
            markOnlineOnConnect: true,
            syncFullHistory: false,
        });
        _socket = socket;

        console.log(`[PAIR] ${mode} socket created (attempt ${attempt}, restart ${restartCount})`);

        socket.ev.process(async (events) => {
            if (!_isCurrent(attempt)) return;

            if (events["creds.update"]) {
                // The 515 close can arrive immediately after the login event.
                // Await this write before handling the close so the replacement
                // socket can load the newly paired credentials from disk.
                await saveCreds();
            }

            const update = events["connection.update"];
            if (!update || !_isCurrent(attempt)) return;

            const { connection, qr, isNewLogin } = update;

            if (isNewLogin) {
                paired = true;
                console.log(`[PAIR] ${mode} new login acknowledged (attempt ${attempt})`);
            }

            if (qr) {
                console.log(`[PAIR] ${mode} challenge received (attempt ${attempt})`);

                if (mode === "code" && !pairingRequested) {
                    pairingRequested = true;
                    try {
                        if (state.creds.registered) {
                            throw new Error("Temporary pairing credentials are already registered; cancel and retry.");
                        }
                        const rawCode = await socket.requestPairingCode(phone);
                        if (!_isCurrent(attempt)) return;
                        _code = rawCode?.match(/.{1,4}/g)?.join("-") || rawCode;
                        _status = "ready";
                        console.log(`[PAIR] Pairing code ready (attempt ${attempt})`);
                    } catch (error) {
                        pairingRequested = false;
                        fail(`Pairing code request failed: ${error.message}`, error);
                    }
                }

                if (mode === "qr") {
                    try {
                        _qrDataUrl = await QRCode.toDataURL(qr, {
                            width: 320,
                            margin: 2,
                            errorCorrectionLevel: "M",
                        });
                        _status = "ready";
                    } catch (error) {
                        fail(`QR generation failed: ${error.message}`, error);
                    }
                }
            }

            if (connection === "open") {
                console.log(`[PAIR] ${mode} socket opened (attempt ${attempt}, restart ${restartCount})`);
                if (state.creds.registered || state.creds.me?.id) paired = true;

                if (paired && _status !== "success") {
                    try {
                        await encodeSession(socket, state, saveCreds);
                    } catch (error) {
                        fail(`Session encode failed: ${error.message}`, error);
                    }
                }
            }

            if (connection !== "close") return;

            const code = _statusCode(update);
            const reason = _disconnectReason(update);
            console.error(`[PAIR] ${mode} socket closed (attempt ${attempt}, restart ${restartCount}): ${reason}`);

            if (code === DisconnectReason.restartRequired || code === 515) {
                if (restartCount >= MAX_RESTARTS) {
                    fail(`WhatsApp requested too many restarts: ${reason}`, new Error(reason));
                    return;
                }

                restartCount += 1;
                _status = "restarting";
                console.log(`[PAIR] Restarting ${mode} socket immediately after status 515 (restart ${restartCount}/${MAX_RESTARTS})`);

                // Do not remove TEMP_DIR. Status 515 is sent after a successful
                // login and the replacement socket must load the saved creds.
                if (!paired) {
                    _code = null;
                    pairingRequested = false;
                }
                if (_socket === socket) _socket = null;
                _safeClose(socket);

                await _delay(SOCKET_RESTART_DELAY_MS);
                try {
                    await startSocket();
                } catch (error) {
                    fail(`Pairing socket restart failed: ${error.message}`, error);
                }
                return;
            }

            if (_status !== "success") {
                fail(`Connection closed before pairing completed: ${reason}`, new Error(reason));
            }
        });
    };

    try {
        await startSocket();
    } catch (error) {
        fail(`Unable to start WhatsApp pairing: ${error.message}`, error);
    }
}

async function startPairing(rawPhone) {
    return _start("code", rawPhone);
}

async function startQrPairing() {
    return _start("qr");
}

function cancelPairing() {
    _reset();
}

module.exports = { startPairing, startQrPairing, cancelPairing, getStatus };