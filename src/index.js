require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "db.json");

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify(
        {
          licenses: {},
        },
        null,
        2
      ),
      "utf8"
    );
    return;
  }

  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw || "{}");

    if (!parsed || typeof parsed !== "object") {
      throw new Error("db inválido");
    }

    if (!parsed.licenses || typeof parsed.licenses !== "object") {
      parsed.licenses = {};
      fs.writeFileSync(DATA_FILE, JSON.stringify(parsed, null, 2), "utf8");
    }
  } catch {
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify(
        {
          licenses: {},
        },
        null,
        2
      ),
      "utf8"
    );
  }
}

function readDb() {
  ensureDataFile();
  const raw = fs.readFileSync(DATA_FILE, "utf8");
  const db = JSON.parse(raw || "{}");

  if (!db.licenses || typeof db.licenses !== "object") {
    db.licenses = {};
  }

  return db;
}

function writeDb(db) {
  ensureDataFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), "utf8");
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function generateLicense() {
  return (
    "BARBER-" +
    crypto.randomBytes(4).toString("hex").toUpperCase() +
    "-" +
    crypto.randomBytes(2).toString("hex").toUpperCase()
  );
}

app.get("/", (req, res) => {
  res.json({
    app: "BarberPro License API",
    status: "online",
    mode: "lifetime_license",
    timestamp: new Date().toISOString(),
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.get("/ping", (req, res) => {
  res.json({
    pong: true,
    timestamp: new Date().toISOString(),
  });
});

app.get("/premium/:email", (req, res) => {
  try {
    const email = normalizeEmail(req.params.email);
    const device_id = String(req.query.device_id || "").trim();
    const db = readDb();
    const lic = db.licenses[email];

    if (!email) {
      return res.json({
        premium: false,
        reason: "invalid_email",
      });
    }

    if (!lic) {
      return res.json({
        premium: false,
        reason: "not_found",
      });
    }

    const status = String(lic.status || "active").trim().toLowerCase();

    if (status !== "active") {
      return res.json({
        premium: false,
        reason: "inactive",
        status,
      });
    }

    const currentDeviceId = String(lic.device_id || "").trim();

    if (!currentDeviceId && device_id) {
      lic.device_id = device_id;
      lic.first_activated_at = lic.first_activated_at || new Date().toISOString();
      db.licenses[email] = lic;
      writeDb(db);
    }

    const expectedDeviceId = String(lic.device_id || "").trim();

    if (expectedDeviceId && device_id && expectedDeviceId !== device_id) {
      return res.json({
        premium: false,
        reason: "device_mismatch",
      });
    }

    return res.json({
      premium: true,
      status: "active",
      email: lic.email || email,
      license: lic.license || null,
      device_id: lic.device_id || null,
      created_at: lic.created_at || null,
      first_activated_at: lic.first_activated_at || null,
    });
  } catch (err) {
    console.error("Erro em /premium/:email", err);
    return res.status(500).json({
      premium: false,
      reason: "server_error",
    });
  }
});

app.get("/license/:email", (req, res) => {
  try {
    const email = normalizeEmail(req.params.email);
    const db = readDb();
    const lic = db.licenses[email];

    if (!lic) {
      return res.status(404).json({
        ok: false,
        error: "licença não encontrada",
      });
    }

    return res.json({
      ok: true,
      ...lic,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "erro ao consultar licença",
      details: error.message,
    });
  }
});

app.post("/license/create", (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const status = String(req.body?.status || "active").trim().toLowerCase();
    const incomingDeviceId = String(req.body?.device_id || "").trim();
    const incomingLicense = String(req.body?.license || "").trim();

    if (!email) {
      return res.status(400).json({
        ok: false,
        error: "email obrigatório",
      });
    }

    const db = readDb();
    const existing = db.licenses[email] || null;

    const licenseRecord = {
      email,
      license: incomingLicense || existing?.license || generateLicense(),
      device_id:
        incomingDeviceId !== ""
          ? incomingDeviceId
          : existing?.device_id || null,
      status: status || existing?.status || "active",
      created_at: existing?.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
      first_activated_at: existing?.first_activated_at || null,
    };

    db.licenses[email] = licenseRecord;
    writeDb(db);

    return res.json({
      ok: true,
      message: existing ? "licença atualizada" : "licença criada",
      license: licenseRecord,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "erro ao criar licença",
      details: error.message,
    });
  }
});

app.post("/license/reset-device", (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);

    if (!email) {
      return res.status(400).json({
        ok: false,
        error: "email obrigatório",
      });
    }

    const db = readDb();
    const lic = db.licenses[email];

    if (!lic) {
      return res.status(404).json({
        ok: false,
        error: "licença não encontrada",
      });
    }

    lic.device_id = null;
    lic.updated_at = new Date().toISOString();

    db.licenses[email] = lic;
    writeDb(db);

    return res.json({
      ok: true,
      message: "device resetado",
      license: lic,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "erro ao resetar device",
      details: error.message,
    });
  }
});

app.post("/license/switch-device", (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();

    if (!email) {
      return res.status(400).json({ error: "email obrigatório" });
    }

    const db = readDb();
    const lic = db.licenses[email];

    if (!lic) {
      return res.status(404).json({ error: "licença não encontrada" });
    }

    const now = Date.now();
    const lastSwitch = lic.last_switch_at
      ? new Date(lic.last_switch_at).getTime()
      : 0;

    const DAY_MS = 24 * 60 * 60 * 1000;

    if (!lic.switch_count || now - lastSwitch > DAY_MS) {
      lic.switch_count = 0;
    }

    if (lic.switch_count >= 3) {
      return res.json({
        ok: false,
        reason: "limit_reached",
        message: "Limite diário de trocas atingido. Tente novamente amanhã.",
      });
    }

    lic.device_id = null;
    lic.switch_count += 1;
    lic.last_switch_at = new Date().toISOString();
    lic.updated_at = new Date().toISOString();

    db.licenses[email] = lic;
    writeDb(db);

    return res.json({
      ok: true,
      message: "Dispositivo liberado",
      switch_count: lic.switch_count,
      remaining_today: Math.max(0, 3 - lic.switch_count),
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "erro ao trocar dispositivo",
      details: e.message,
    });
  }
});

app.listen(PORT, () => {
  ensureDataFile();
  console.log(`✅ License server running on port ${PORT}`);
});