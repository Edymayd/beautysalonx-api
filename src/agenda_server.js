const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.use(express.static(path.join(__dirname, "../public")));

const PORT = process.env.AGENDA_PORT || 3001;
const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "agenda.json");

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(DATA_FILE)) {
    const initialData = {
      appointments: [],
      professionals: [],
      updated_at: new Date().toISOString(),
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initialData, null, 2), "utf8");
  }
}

function readDb() {
  ensureDataFile();
  const raw = fs.readFileSync(DATA_FILE, "utf8");
  try {
    const data = JSON.parse(raw);
    if (!data.professionals) data.professionals = [];
    if (!data.appointments) data.appointments = [];
    return data;
  } catch {
    return {
      appointments: [],
      professionals: [],
      updated_at: new Date().toISOString(),
    };
  }
}

function writeDb(data) {
  const payload = {
    appointments: Array.isArray(data.appointments) ? data.appointments : [],
    professionals: Array.isArray(data.professionals) ? data.professionals : [],
    updated_at: new Date().toISOString(),
  };

  fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

function addMinutes(hhmm, minutesToAdd) {
  const [hh, mm] = String(hhmm || "00:00").split(":").map(Number);
  const total = (hh * 60) + (mm || 0) + Number(minutesToAdd || 0);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function normalizeAppointment(input = {}) {
  const start = String(input.start || "").trim();
  const duration_min = Number(input.duration_min || 0);

  let end = String(input.end || "").trim();
  if (!end && start && duration_min > 0) {
    end = addMinutes(start, duration_min);
  }

  return {
    id: String(input.id || `apt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
    date: String(input.date || "").trim(),
    start,
    end,
    client_id: input.client_id ?? null,
    client_name: String(input.client_name || "").trim(),
    service_id: input.service_id ?? null,
    service_name: String(input.service_name || "").trim(),
    professional_id: input.professional_id ?? null,
    professional_name: String(input.professional_name || "").trim(),
    price: Number(input.price || 0),
    duration_min,
    status: String(input.status || "scheduled").trim(),
    notes: String(input.notes || "").trim(),
    updated_at: new Date().toISOString(),
  };
}

function normalizeProfessional(input = {}) {
  return {
    id:
      input.id ||
      `pro_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: String(input.name || input.professional_name || "").trim(),
    active: input.active == null ? 1 : Number(input.active),
  };
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    app: "BeautySalonX Agenda Server",
    status: "online",
  });
});

app.get("/agenda/health", (req, res) => {
  const db = readDb();
  res.json({
    ok: true,
    appointments: db.appointments.length,
    professionals: db.professionals.length,
  });
});

/* =======================
   APPOINTMENTS
======================= */

app.get("/agenda/appointments", (req, res) => {
  const db = readDb();
  const date = String(req.query.date || "").trim();

  let items = [...db.appointments];

  if (date) {
    items = items.filter((a) => a.date === date);
  }

  res.json({ ok: true, items });
});

app.post("/agenda/appointments", (req, res) => {
  const db = readDb();

  const body = { ...(req.body || {}) };

  if (!body.professional_id && body.professional_name) {
    const profName = String(body.professional_name).trim().toLowerCase();

    const prof = (db.professionals || []).find(
      (p) => String(p.name || "").trim().toLowerCase() === profName
    );

    if (prof) {
      body.professional_id = prof.id;
      body.professional_name = prof.name;
    }
  }

  const appt = normalizeAppointment(body);

  db.appointments.push(appt);
  writeDb(db);

  res.json({ ok: true, item: appt });
});

app.put("/agenda/appointments/:id", (req, res) => {
  const db = readDb();
  const id = String(req.params.id || "").trim();

  const idx = db.appointments.findIndex((a) => String(a.id) === id);

  if (idx === -1) {
    return res.status(404).json({
      ok: false,
      error: "agendamento nao encontrado",
    });
  }

  const incoming = { ...(req.body || {}) };

  if (!incoming.professional_id && incoming.professional_name) {
    const profName = String(incoming.professional_name).trim().toLowerCase();

    const prof = (db.professionals || []).find(
      (p) => String(p.name || "").trim().toLowerCase() === profName
    );

    if (prof) {
      incoming.professional_id = prof.id;
      incoming.professional_name = prof.name;
    }
  }

  const merged = {
    ...db.appointments[idx],
    ...incoming,
    id: db.appointments[idx].id,
    updated_at: new Date().toISOString(),
  };

  db.appointments[idx] = normalizeAppointment(merged);
  writeDb(db);

  res.json({ ok: true, item: db.appointments[idx] });
});

app.post("/agenda/appointments/:id/close", (req, res) => {
  const db = readDb();
  const id = String(req.params.id || "").trim();

  const idx = db.appointments.findIndex((a) => String(a.id) === id);

  if (idx === -1) {
    return res.status(404).json({
      ok: false,
      error: "agendamento não encontrado",
    });
  }

  const current = db.appointments[idx] || {};

  const updated = {
    ...current,
    status: "closed",
    updated_at: new Date().toISOString(),
  };

  db.appointments[idx] = normalizeAppointment(updated);
  writeDb(db);

  res.json({
    ok: true,
    item: db.appointments[idx],
  });
});

app.delete("/agenda/appointments/:id", (req, res) => {
  const db = readDb();
  const id = String(req.params.id || "").trim();

  const before = db.appointments.length;
  db.appointments = db.appointments.filter((a) => String(a.id) !== id);

  if (db.appointments.length === before) {
    return res.status(404).json({
      ok: false,
      error: "agendamento não encontrado",
    });
  }

  writeDb(db);

  res.json({
    ok: true,
    deleted_id: id,
  });
});

/* =======================
   PROFESSIONALS
======================= */

app.get("/agenda/professionals", (req, res) => {
  const db = readDb();
  res.json({ ok: true, items: db.professionals });
});

app.post("/agenda/professionals", (req, res) => {
  const db = readDb();
  const prof = normalizeProfessional(req.body || {});

  db.professionals.push(prof);
  writeDb(db);

  res.json({ ok: true, item: prof });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Agenda server online em http://0.0.0.0:${PORT}`);
});