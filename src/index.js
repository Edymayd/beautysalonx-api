require("dotenv").config();

const express = require("express");
const cors = require("cors");
const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const APP_URL =
  process.env.APP_URL || "https://beautysalonx-api-2.onrender.com";
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || "troque-este-token";

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
          payments: {},
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
  return JSON.parse(raw);
}

function writeDb(db) {
  ensureDataFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), "utf8");
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function generateId(prefix = "pay") {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function generateLicense() {
  return (
    "BSX-" +
    crypto.randomBytes(4).toString("hex").toUpperCase() +
    "-" +
    crypto.randomBytes(2).toString("hex").toUpperCase()
  );
}

function getPlanAmount(plano) {
  const plan = String(plano || "").toLowerCase();

  if (plan === "vitalicio" || plan === "lifetime") return 89.9;
  if (plan === "anual") return 149.9;

  return 24.9;
}

function getPlanLabel(plano) {
  const plan = String(plano || "").toLowerCase();

  if (plan === "vitalicio" || plan === "lifetime") return "Vitalício";
  if (plan === "anual") return "Anual";

  return "Mensal";
}

function getExpiresAt(minutes = 30) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

function buildPixCopyPaste({ id, email, plano, valor }) {
  return `PIX|ID:${id}|EMAIL:${email}|PLANO:${plano}|VALOR:${Number(valor).toFixed(
    2
  )}`;
}

async function buildPixPayload(payment) {
  const pixCopiaECola = buildPixCopyPaste(payment);
  const qrCodeBase64 = await QRCode.toDataURL(pixCopiaECola);

  return {
    pixCopiaECola,
    qrCodeBase64,
  };
}

function getLatestPaidPaymentByEmail(db, email) {
  const targetEmail = normalizeEmail(email);

  const payments = Object.values(db.payments || {})
    .filter(
      (p) =>
        normalizeEmail(p.email) === targetEmail &&
        String(p.status || "").toLowerCase() === "paid"
    )
    .sort((a, b) => {
      const aTime = new Date(a.paid_at || a.created_at || 0).getTime();
      const bTime = new Date(b.paid_at || b.created_at || 0).getTime();
      return bTime - aTime;
    });

  return payments[0] || null;
}

function activatePayment(db, payment, extra = {}) {
  if (payment.status === "paid" && payment.license) {
    return {
      payment,
      licenseRecord: db.licenses[payment.email] || null,
      alreadyPaid: true,
    };
  }

  const license = generateLicense();
  const paidAt = new Date().toISOString();

  payment.status = "paid";
  payment.paid_at = paidAt;
  payment.license = license;
  payment.provider = extra.provider || payment.provider || "mock";
  payment.provider_payment_id =
    extra.provider_payment_id || payment.provider_payment_id || null;
  payment.webhook_received_at = extra.webhook_received_at || null;

  db.payments[payment.id] = payment;

  const licenseRecord = {
    email: payment.email,
    plano: payment.plano,
    license,
    payment_id: payment.id,
    activated_at: paidAt,
  };

  db.licenses[payment.email] = licenseRecord;

  return {
    payment,
    licenseRecord,
    alreadyPaid: false,
  };
}

app.get("/", (req, res) => {
  res.json({
    app: "BeautySalonX API",
    status: "online",
    env: process.env.NODE_ENV || "development",
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
    const db = readDb();

    const lic = db.licenses[email];
    const latestPaid = getLatestPaidPaymentByEmail(db, email);

    if (!lic && !latestPaid) {
      return res.json({
        premium: false,
      });
    }

    const plano = lic?.plano || latestPaid?.plano || null;
    const license = lic?.license || null;
    const status = lic?.status || "active";
    const expires_at = lic?.expires_at || null;

    if (expires_at && new Date(expires_at) < new Date()) {
      return res.json({
        premium: false,
        expired: true,
        plano,
        expires_at,
        status: "expired",
      });
    }

    return res.json({
      premium: true,
      plano,
      license,
      expires_at,
      status,
    });
  } catch (err) {
    console.error("Erro em /premium/:email", err);
    return res.status(500).json({
      error: "erro ao verificar premium",
    });
  }
});

app.post("/pix/create", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const plano = String(req.body.plano || "mensal").toLowerCase();

    if (!email) {
      return res.status(400).json({
        error: "email obrigatório",
      });
    }

    const valor = getPlanAmount(plano);
    const id = generateId("pix");
    const expiresAt = getExpiresAt(30);

    const payment = {
      id,
      email,
      plano,
      valor,
      status: "pending",
      created_at: new Date().toISOString(),
      expires_at: expiresAt,
      paid_at: null,
      license: null,
      provider: "mock",
      provider_payment_id: null,
      webhook_received_at: null,
    };

    const db = readDb();
    db.payments[id] = payment;
    writeDb(db);

    const pix = await buildPixPayload(payment);

    return res.json({
      ok: true,
      payment_id: payment.id,
      id: payment.id,
      email: payment.email,
      plano: payment.plano,
      plan_label: getPlanLabel(payment.plano),
      valor: payment.valor,
      status: payment.status,
      created_at: payment.created_at,
      expires_at: payment.expires_at,
      pixCopiaECola: pix.pixCopiaECola,
      qrCodeBase64: pix.qrCodeBase64,
      check_url: `${APP_URL}/pix/check/${payment.id}`,
      status_url: `${APP_URL}/pix/status/${payment.id}`,
      confirm_url: `${APP_URL}/pix/confirm/${payment.id}`,
      premium_url: `${APP_URL}/premium/${encodeURIComponent(payment.email)}`,
      app_checkout: {
        payment_id: payment.id,
        email: payment.email,
        plano: payment.plano,
        plan_label: getPlanLabel(payment.plano),
        amount: payment.valor,
        status: payment.status,
        pix_code: pix.pixCopiaECola,
        qr_code_base64: pix.qrCodeBase64,
        expires_at: payment.expires_at,
        check_url: `${APP_URL}/pix/check/${payment.id}`,
        status_url: `${APP_URL}/pix/status/${payment.id}`,
        premium_url: `${APP_URL}/premium/${encodeURIComponent(payment.email)}`,
      },
    });
  } catch (error) {
    return res.status(500).json({
      error: "erro ao criar cobrança pix",
      details: error.message,
    });
  }
});

app.post("/pix/confirm", (req, res) => {
  const { paymentId } = req.body;

  const payment = payments[paymentId];

  if (!payment) {
    return res.status(404).json({
      error: "Pagamento não encontrado",
    });
  }

  if (payment.status === "paid") {
    return res.json({
      ok: true,
      message: "Pagamento já confirmado",
    });
  }

  // marca como pago
  payment.status = "paid";

  // gera licença
  const license = generateLicense();

  const now = new Date();
const expires = new Date(now);

if (payment.plano === "mensal") {
  expires.setDate(expires.getDate() + 30);
} else if (payment.plano === "semestral") {
  expires.setDate(expires.getDate() + 180);
} else if (payment.plano === "anual") {
  expires.setDate(expires.getDate() + 365);
} else {
  expires.setDate(expires.getDate() + 30);
}

licenses[payment.email] = {
  plano: payment.plano,
  license,
  created: now.toISOString(),
  expires_at: expires.toISOString(),
  status: "active",
};

  res.json({
    ok: true,
    license,
  });
});


app.get("/pix/status/:id", (req, res) => {
  try {
    const db = readDb();
    const payment = db.payments[req.params.id];

    if (!payment) {
      return res.status(404).json({
        error: "pagamento não encontrado",
      });
    }

    return res.json({
      ok: true,
      id: payment.id,
      payment_id: payment.id,
      email: payment.email,
      plano: payment.plano,
      plan_label: getPlanLabel(payment.plano),
      valor: payment.valor,
      status: payment.status,
      created_at: payment.created_at,
      expires_at: payment.expires_at || null,
      paid_at: payment.paid_at,
      license: payment.license,
      provider: payment.provider || null,
      provider_payment_id: payment.provider_payment_id || null,
      webhook_received_at: payment.webhook_received_at || null,
      premium_url: `${APP_URL}/premium/${encodeURIComponent(payment.email)}`,
    });
  } catch (error) {
    return res.status(500).json({
      error: "erro ao consultar status do pagamento",
      details: error.message,
    });
  }
});

app.get("/pix/check/:id", (req, res) => {
  try {
    const db = readDb();
    const payment = db.payments[req.params.id];

    if (!payment) {
      return res.status(404).json({
        ok: false,
        error: "pagamento não encontrado",
      });
    }

    return res.json({
      ok: true,
      payment_id: payment.id,
      paid: payment.status === "paid",
      premium: payment.status === "paid",
      status: payment.status,
      plano: payment.plano,
      plan_label: getPlanLabel(payment.plano),
      email: payment.email,
      license: payment.license || null,
      paid_at: payment.paid_at || null,
      expires_at: payment.expires_at || null,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "erro ao verificar pagamento",
      details: error.message,
    });
  }
});

app.post("/pix/confirm/:id", (req, res) => {
  try {
    const paymentId = req.params.id;
    const db = readDb();
    const payment = db.payments[paymentId];

    if (!payment) {
      return res.status(404).json({
        error: "pagamento não encontrado",
      });
    }

    const result = activatePayment(db, payment, {
      provider: "manual",
      provider_payment_id: `manual_${paymentId}`,
    });

    writeDb(db);

    return res.json({
      ok: true,
      message: result.alreadyPaid
        ? "pagamento já estava confirmado"
        : "pagamento confirmado manualmente e licença gerada",
      payment_id: result.payment.id,
      email: result.payment.email,
      plano: result.payment.plano,
      license: result.payment.license,
      alreadyPaid: result.alreadyPaid,
    });
  } catch (error) {
    return res.status(500).json({
      error: "erro ao confirmar pagamento",
      details: error.message,
    });
  }
});

app.get("/webhook/pix", (req, res) => {
  res.json({
    ok: true,
    route: "webhook pix ready",
  });
});

app.post("/webhook/pix", (req, res) => {
  try {
    const token = req.headers["x-webhook-token"];

    if (token !== WEBHOOK_TOKEN) {
      return res.status(401).json({
        error: "token inválido",
      });
    }

    const paymentId = String(req.body.payment_id || "").trim();
    const provider = String(req.body.provider || "pix-provider").trim();
    const providerPaymentId = String(
      req.body.provider_payment_id || ""
    ).trim();

    if (!paymentId) {
      return res.status(400).json({
        error: "payment_id obrigatório",
      });
    }

    const db = readDb();
    const payment = db.payments[paymentId];

    if (!payment) {
      return res.status(404).json({
        error: "pagamento não encontrado",
      });
    }

    const result = activatePayment(db, payment, {
      provider,
      provider_payment_id: providerPaymentId || `prov_${paymentId}`,
      webhook_received_at: new Date().toISOString(),
    });

    writeDb(db);

    return res.json({
      ok: true,
      message: result.alreadyPaid
        ? "webhook recebido, pagamento já estava pago"
        : "webhook recebido, pagamento ativado",
      payment_id: result.payment.id,
      email: result.payment.email,
      plano: result.payment.plano,
      license: result.payment.license,
      alreadyPaid: result.alreadyPaid,
    });
  } catch (error) {
    return res.status(500).json({
      error: "erro no webhook pix",
      details: error.message,
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
        error: "licença não encontrada",
      });
    }

    return res.json({
      ok: true,
      ...lic,
    });
  } catch (error) {
    return res.status(500).json({
      error: "erro ao consultar licença",
      details: error.message,
    });
  }
});

app.get("/pay", (req, res) => {
  res.send(`
  <html>
  <head>
    <title>BeautySalonX Premium</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body{
        font-family: Arial;
        background:#f3f4f6;
        padding:30px;
        text-align:center;
      }
      .card{
        background:white;
        padding:25px;
        border-radius:10px;
        max-width:420px;
        margin:auto;
        box-shadow:0 10px 20px rgba(0,0,0,0.1);
      }
      button{
        background:#2563EB;
        color:white;
        border:none;
        padding:12px 20px;
        border-radius:8px;
        font-size:16px;
        cursor:pointer;
      }
      input{
        width:100%;
        padding:10px;
        margin:10px 0;
      }
    </style>
  </head>
  <body>

    <div class="card">
      <h2>BeautySalonX Premium</h2>

      <p>Plano mensal</p>
      <h3>R$ 24,90</h3>

      <input id="email" placeholder="Digite seu email"/>

      <button onclick="gerarPix()">Gerar PIX</button>

      <div id="pix"></div>
    </div>

    <script>
      async function gerarPix(){
  const email = document.getElementById("email").value.trim().toLowerCase();

  if (!email || !email.includes("@")) {
    alert("Digite um email válido.");
    return;
  }

  const r = await fetch("/pix/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: email,
      plano: "mensal"
    })
  });

  const data = await r.json();

  if (!r.ok) {
    alert(data.error || "Erro ao gerar PIX.");
    return;
  }

  const qr =
  data.qrCodeBase64 ||
  data.qr ||
  data.qrCode ||
  data.qr_code ||
  data?.app_checkout?.qr_code_base64 ||
  null;

  if (!qr) {
    alert("O servidor não retornou o QR Code.");
    return;
  }

  document.getElementById("pix").innerHTML =
  "<p>Escaneie o código QR:</p><img src='" + qr + "' width='250'/>";
}


app.listen(PORT, () => {
  ensureDataFile();
  console.log(`✅ Server running on port ${PORT}`);
});