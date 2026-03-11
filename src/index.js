require("dotenv").config();

const express = require("express");
const cors = require("cors");
const QRCode = require("qrcode");

const app = express();

app.use(cors());
app.use(express.json());

const payments = {};
const licenses = {};

function generateLicense() {
  return "BSX-" + Math.random().toString(36).substring(2, 10).toUpperCase();
}

app.get("/", (req, res) => {
  res.json({
    app: "BeautySalonX API",
    status: "online",
  });
});

app.get("/premium/:email", (req, res) => {
  const lic = licenses[req.params.email];

  if (!lic) {
    return res.json({
      premium: false,
    });
  }

  res.json({
    premium: true,
    plano: lic.plano,
    license: lic.license,
  });
});

app.post("/pix/create", async (req, res) => {
  const { email, plano } = req.body;

  if (!email) {
    return res.status(400).json({
      error: "email obrigatório",
    });
  }

  const paymentId = "pay_" + Date.now();

  const pixCode =
    "00020126360014BR.GOV.BCB.PIX0114beautysalonx520400005303986540524.905802BR5920BeautySalonX6009SAO PAULO62070503***6304ABCD";

  const qr = await QRCode.toDataURL(pixCode);

  payments[paymentId] = {
    email,
    plano: plano || "premium",
    status: "pending",
  };

  res.json({
    payment_id: paymentId,
    valor: 24.9,
    pix_code: pixCode,
    qr_code: qr,
  });
});

app.post("/pix/confirm/:id", (req, res) => {
  const payment = payments[req.params.id];

  if (!payment) {
    return res.status(404).json({
      error: "pagamento não encontrado",
    });
  }

  payment.status = "paid";

  const license = generateLicense();

  licenses[payment.email] = {
    license,
    plano: payment.plano,
  };

  res.json({
    ok: true,
    license,
  });
});

const PORT = process.env.PORT || 3333;

app.listen(PORT, () => {
  console.log("Servidor rodando na porta " + PORT);
});