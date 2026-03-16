require("dotenv").config();

const express = require("express");
const cors = require("cors");
const QRCode = require("qrcode");
const { MercadoPagoConfig, Payment } = require("mercadopago");

const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
});

const mpPayment = new Payment(mpClient);
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
  const qrCodeBase64 =
    payment?.point_of_interaction?.transaction_data?.qr_code_base64 || null;

  const pixCopiaECola =
    payment?.point_of_interaction?.transaction_data?.qr_code || null;

  return {
    pixCopiaECola,
    qrCodeBase64: qrCodeBase64
      ? `data:image/png;base64,${qrCodeBase64}`
      : null,
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

app.get("/warmup", (req, res) => {
  res.json({ ok: true });
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

app.get("/premium/:email", async (req, res) => {
  try {
    const email = normalizeEmail(req.params.email);
    const device_id = String(req.query.device_id || "");
    const db = readDb();

    const emailPayments = Object.values(db.payments || {})
      .filter((p) => normalizeEmail(p.email) === email)
      .sort((a, b) => {
        const aTime = new Date(a.created_at || 0).getTime();
        const bTime = new Date(b.created_at || 0).getTime();
        return bTime - aTime;
      });

    for (const p of emailPayments) {
      if (String(p.status || "").toLowerCase() === "paid") continue;

      const expectedDeviceId = String(p.device_id || "");
      if (device_id && expectedDeviceId && device_id !== expectedDeviceId) {
        continue;
      }

      try {
        const mpPaymentId = String(p.provider_payment_id || p.id || "");
        if (!mpPaymentId) continue;

        const mpInfo = await mpPayment.get({ id: mpPaymentId });
        const mpStatus = String(mpInfo?.status || "").toLowerCase();

        if (mpStatus === "approved") {
          const result = activatePayment(db, p, {
            provider: "mercadopago",
            provider_payment_id: mpPaymentId,
            webhook_received_at: new Date().toISOString(),
          });

          db.licenses[email] = {
            ...(db.licenses[email] || {}),
            ...(result.licenseRecord || {}),
            status: "active",
            device_id: p.device_id || null,
          };

          writeDb(db);
          break;
        }
      } catch (e) {
        console.log("Erro ao conferir pagamento no Mercado Pago:", e?.message || e);
      }
    }

    const lic = db.licenses[email];
    const latestPaid = getLatestPaidPaymentByEmail(db, email);

    if (!lic && !latestPaid) {
      return res.json({
        premium: false,
      });
    }

    const paymentDeviceId = String(latestPaid?.device_id || "");
    const licenseDeviceId = String(lic?.device_id || "");
    const expectedDeviceId = licenseDeviceId || paymentDeviceId || "";

    if (expectedDeviceId && device_id && expectedDeviceId !== device_id) {
      return res.json({
        premium: false,
        reason: "device_mismatch",
      });
    }

    const plano = lic?.plano || latestPaid?.plano || null;
    const license = lic?.license || latestPaid?.license || null;
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
    const { email, plano, device_id } = req.body;

    const prices = {
      mensal: 24.9,
      semestral: 149,
      anual: 298
    };

    const amount = prices[plano];

    if (!email) {
      return res.status(400).json({ error: "email obrigatório" });
    }

    if (!amount) {
      return res.status(400).json({ error: "plano inválido" });
    }

    const mpRes = await mpPayment.create({
      body: {
        transaction_amount: amount,
        description: "BeautySalonX Premium",
        payment_method_id: "pix",
        payer: {
          email: email
        }
      }
    });

    const qr = mpRes?.point_of_interaction?.transaction_data?.qr_code || null;
    const qrBase64 = mpRes?.point_of_interaction?.transaction_data?.qr_code_base64 || null;

    const db = readDb();

    db.payments[String(mpRes.id)] = {
      id: String(mpRes.id),
      email: normalizeEmail(email),
      plano,
      valor: amount,
      status: String(mpRes.status || "pending").toLowerCase(),
      created_at: new Date().toISOString(),
      paid_at: null,
      license: null,
      provider: "mercadopago",
      provider_payment_id: String(mpRes.id),
      device_id: device_id || null,
      webhook_received_at: null
    };

    writeDb(db);

    return res.json({
      ok: true,
      payment_id: String(mpRes.id),
      status: String(mpRes.status || "pending").toLowerCase(),
      qr_code: qr,
      qr_code_base64: qrBase64
    });
  } catch (err) {
    console.error("Erro ao criar pix:", err?.message || err);

    return res.status(500).json({
      error: "erro ao criar pix"
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


app.get("/pix/status/:id", async (req, res) => {
res.set("Cache-Control", "no-store");
res.set("Pragma", "no-cache");  
try {
    const db = readDb();
    const payment = db.payments[req.params.id];

    if (!payment) {
      return res.status(404).json({
        error: "pagamento não encontrado",
      });
    }

    const mpResult = await mpPayment.get({ id: req.params.id });
    const mpStatus = String(mpResult?.status || "").toLowerCase();

    if (mpStatus === "approved" && payment.status !== "paid") {
      payment.status = "paid";
      payment.paid_at = new Date().toISOString();

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

      db.licenses[payment.email] = {
        email: payment.email,
        plano: payment.plano,
        license,
        created: now.toISOString(),
        expires_at: expires.toISOString(),
        status: "active",
        device_id: payment.device_id || null,
      };

      payment.license = license;

      writeDb(db);
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
      expires_at: db.licenses[payment.email]?.expires_at || null,
      paid_at: payment.paid_at || null,
      license: payment.license || null,
      premium_url: `${APP_URL}/premium/${encodeURIComponent(payment.email)}?device_id=${encodeURIComponent(payment.device_id || "")}`,
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

app.get("/delete-account", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Excluir conta - BeautySalonX</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body style="font-family: Arial; padding: 20px;">
        <h2>Excluir conta - BeautySalonX</h2>
        <p>Para solicitar a exclusão dos seus dados, envie um e-mail para:</p>
        <p><b>bsalonx@gmail.com</b></p>
        <p>Informe o e-mail utilizado no app.</p>
      </body>
    </html>
  `);
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
      input, textarea, select{
        width:100%;
        padding:10px;
        margin:10px 0;
        box-sizing:border-box;
      }
      img{
        max-width:100%;
        height:auto;
      }
      .muted{
        color:#666;
        font-size:14px;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <h2>BeautySalonX Premium</h2>

      <p>Escolha seu plano</p>
      <select id="plano">
  <option value="mensal">Mensal - R$ 24,90</option>
  <option value="semestral">Semestral - R$ 149,00</option>
  <option value="anual">Anual - R$ 298,00</option>
</select>

      <input id="email" value="${req.query.email || ""}" placeholder="Digite seu email" />

      <button onclick="gerarPix()">Gerar PIX</button>

      <div id="pix" style="margin-top:20px;"></div>
    </div>

    <script>
      async function gerarPix() {
        const email = document.getElementById("email").value.trim().toLowerCase();
        const plano = document.getElementById("plano").value;
        const pixDiv = document.getElementById("pix");

        if (!email || !email.includes("@")) {
          pixDiv.innerHTML = "<p style='color:red;'>Digite um email válido.</p>";
          return;
        }

        pixDiv.innerHTML = "<p>Gerando PIX...</p>";

        try {
          const r = await fetch("/pix/create", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            
body: JSON.stringify({
  email: email,
  plano: plano,
  device_id: new URLSearchParams(window.location.search).get("device_id") || "WEB-PAY"
})
          });

          const data = await r.json();
 
          const paymentId = data.payment_id || data.id;

if (paymentId) {
  verificarPagamento(paymentId);
}

          const qrRaw =
  data.qr_code_base64 ||
  data.qrCodeBase64 ||
  data.qr ||
  data.qrCode ||
  null;

const qr = qrRaw
  ? (String(qrRaw).startsWith("data:image")
      ? qrRaw
      : ("data:image/png;base64," + qrRaw))
  : null;

const copia =
  data.qr_code ||
  data.pixCopiaECola ||
  data.pix_code ||
  "";

          if (!r.ok) {
            pixDiv.innerHTML =
              "<p style='color:red;'>Erro ao gerar PIX</p>" +
              "<pre style='text-align:left;white-space:pre-wrap;'>" +
              JSON.stringify(data, null, 2) +
              "</pre>";
            return;
          }

          if (!qr) {
            pixDiv.innerHTML =
              "<p style='color:red;'>QR não encontrado no retorno</p>" +
              "<pre style='text-align:left;white-space:pre-wrap;'>" +
              JSON.stringify(data, null, 2) +
              "</pre>";
            return;
          }

          pixDiv.innerHTML =
  "<p>Escaneie o código QR:</p>" +
  "<img src='" + qr + "' width='250' style='display:block;margin:10px auto;' />" +
  "<p style='margin-top:10px;font-size:12px;color:#666;'>ID do pagamento: " + paymentId + "</p>" +
  "<p style='margin-top:15px;'>PIX copia e cola:</p>" +
  "<textarea readonly>" + copia + "</textarea>" +
  "<p class='muted'>Após pagar, aguarde alguns segundos nesta tela para confirmação automática.</p>";
        } catch (err) {
          pixDiv.innerHTML =
            "<p style='color:red;'>Falha ao chamar o servidor</p>" +
            "<pre style='text-align:left;white-space:pre-wrap;'>" +
            String(err) +
            "</pre>";
        }
      }

async function verificarPagamento(paymentId) {

  const pixDiv = document.getElementById("pix");

  const interval = setInterval(async () => {

    try {

      const r = await fetch("/pix/status/" + paymentId + "?t=" + Date.now(), {
  cache: "no-store"
});
      const data = await r.json();

      if (data.status === "paid") {

        clearInterval(interval);

        pixDiv.innerHTML +=
          "<h3 style='color:green'>Pagamento confirmado ✅</h3>" +
          "<p>Seu Premium já está ativo.</p>" +
          "<p>Volte ao aplicativo BeautySalonX.</p>";

      }

    } catch (err) {
      console.log(err);
    }

  }, 4000);

}


    </script>
  </body>
  </html>
  `);
});


app.listen(PORT, () => {
  ensureDataFile();
  console.log(`✅ Server running on port ${PORT}`);
});