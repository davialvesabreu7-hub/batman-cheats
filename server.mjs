import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import nodemailer from "nodemailer";
import QRCode from "qrcode";
import Database from "better-sqlite3";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3000);
const dbPath = process.env.DB_PATH || path.join(__dirname, "data", "orders.sqlite");
const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    product TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    customer_name TEXT NOT NULL,
    customer_email TEXT NOT NULL,
    customer_phone TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    paid_at TEXT,
    email_sent_at TEXT
  );
  CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
`);

const PRODUCTS = {
  "Batman Gerador Sensi": 290,
  "Guarana Sensi": 390,
  "Batman Sensi VIP": 699,
  "Membro Batman Cheats": 299
};

app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/api/", rateLimit({ windowMs: 60_000, limit: 40, standardHeaders: true, legacyHeaders: false }));

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Falta configurar ${name} no arquivo .env`);
  return value;
}
function centsToBRL(cents) {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function cleanString(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function adminAuth(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "Faça login como administrador." });
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  const session = db.prepare("SELECT expires_at FROM admin_sessions WHERE token_hash = ?").get(hash);
  if (!session || session.expires_at < Date.now()) {
    if (session) db.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").run(hash);
    return res.status(401).json({ error: "Sessão expirada. Entre novamente." });
  }
  next();
}

function makePixPayload({ key, name, city, amount, txid }) {
  const tlv = (id, value) => {
    const v = String(value);
    return id + String(Buffer.byteLength(v, "utf8")).padStart(2, "0") + v;
  };
  const merchantAccount = tlv("00", "BR.GOV.BCB.PIX") + tlv("01", key);
  const mai = tlv("26", merchantAccount);
  const additional = tlv("05", txid);
  let payload =
    tlv("00", "01") +
    tlv("01", "12") +
    mai +
    tlv("52", "0000") +
    tlv("53", "986") +
    tlv("54", (amount / 100).toFixed(2)) +
    tlv("58", "BR") +
    tlv("59", name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").slice(0, 25)) +
    tlv("60", city.normalize("NFD").replace(/[\u0300-\u036f]/g, "").slice(0, 15)) +
    tlv("62", additional) +
    "6304";
  let crc = 0xffff;
  for (const byte of Buffer.from(payload, "utf8")) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
    crc &= 0xffff;
  }
  return payload + crc.toString(16).toUpperCase().padStart(4, "0");
}

function getMailer() {
  const host = process.env.SMTP_HOST?.trim();
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  return nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "false") === "true",
    auth: { user, pass }
  });
}

app.get("/api/config", (_req, res) => {
  res.json({ products: Object.entries(PRODUCTS).map(([name, cents]) => ({ name, amount: centsToBRL(cents), amountCents: cents })) });
});

app.post("/api/orders", async (req, res) => {
  try {
    const product = cleanString(req.body?.product, 80);
    const name = cleanString(req.body?.name, 100);
    const email = cleanString(req.body?.email, 160).toLowerCase();
    const phone = cleanString(req.body?.phone, 25);
    if (!PRODUCTS[product]) return res.status(400).json({ error: "Produto inválido." });
    if (name.length < 2) return res.status(400).json({ error: "Informe seu nome." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Informe um e-mail válido." });

    const id = crypto.randomUUID().replaceAll("-", "").slice(0, 25).toUpperCase();
    const amountCents = PRODUCTS[product];
    const createdAt = new Date().toISOString();
    db.prepare(`INSERT INTO orders (id, product, amount_cents, customer_name, customer_email, customer_phone, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, product, amountCents, name, email, phone, createdAt);

    let pixCopyPaste = null;
    let qrDataUrl = null;
    let pixNote = "O Pix ainda não foi configurado pelo administrador.";
    const pixReady = ["PIX_KEY", "PIX_RECEIVER_NAME", "PIX_RECEIVER_CITY"].every(k => process.env[k]?.trim());
    if (pixReady) {
      pixCopyPaste = makePixPayload({
        key: requireEnv("PIX_KEY"),
        name: requireEnv("PIX_RECEIVER_NAME"),
        city: requireEnv("PIX_RECEIVER_CITY"),
        amount: amountCents,
        txid: id
      });
      qrDataUrl = await QRCode.toDataURL(pixCopyPaste, { errorCorrectionLevel: "M", margin: 2, width: 300 });
      pixNote = "Pague o valor exato e aguarde a conferência manual do recebimento.";
    }
    const mailer = getMailer();
    if (mailer) {
      try {
        await mailer.sendMail({
          from: requireEnv("EMAIL_FROM"),
          to: email,
          subject: `Pedido ${id} recebido — BATMAN CHEATS`,
          text: `Olá, ${name}!\n\nRecebemos seu pedido na BATMAN CHEATS.\nProduto: ${product}\nValor: ${centsToBRL(amountCents)}\nPedido: ${id}\nStatus: aguardando confirmação manual do pagamento.\n\nNão envie senhas ou dados bancários por e-mail.`
        });
      } catch (err) {
        console.error("Falha no e-mail de confirmação:", err.message);
      }
    }

    res.status(201).json({
      orderId: id,
      product,
      amount: centsToBRL(amountCents),
      status: "pending",
      pixCopyPaste,
      qrDataUrl,
      pixNote,
      emailConfirmation: Boolean(mailer)
    });
  } catch (err) {
    console.error("Falha ao criar pedido:", err);
    res.status(500).json({ error: "Não foi possível criar o pedido. Verifique a configuração do servidor." });
  }
});

app.post("/api/admin/login", (req, res) => {
  const configured = process.env.ADMIN_PASSWORD;
  if (!configured) return res.status(503).json({ error: "Configure ADMIN_PASSWORD no .env antes de usar o painel." });
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!safeEqual(password, configured)) return res.status(401).json({ error: "Senha incorreta." });
  const token = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  db.prepare("INSERT INTO admin_sessions (token_hash, expires_at) VALUES (?, ?)").run(hash, Date.now() + 8 * 60 * 60 * 1000);
  res.json({ token, expiresInHours: 8 });
});

app.get("/api/admin/orders", adminAuth, (_req, res) => {
  const orders = db.prepare(`SELECT id, product, amount_cents, customer_name, customer_email, customer_phone, status, created_at, paid_at, email_sent_at
    FROM orders ORDER BY created_at DESC LIMIT 200`).all();
  res.json(orders.map(o => ({ ...o, amount: centsToBRL(o.amount_cents) })));
});

app.post("/api/admin/orders/:id/confirm", adminAuth, async (req, res) => {
  const id = cleanString(req.params.id, 40);
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
  if (!order) return res.status(404).json({ error: "Pedido não encontrado." });
  if (order.status === "paid") return res.json({ ok: true, message: "Este pedido já foi confirmado." });

  // Só use este botão depois de conferir o recebimento real no aplicativo do banco.
  const paidAt = new Date().toISOString();
  db.prepare("UPDATE orders SET status = 'paid', paid_at = ? WHERE id = ?").run(paidAt, id);

  const mailer = getMailer();
  if (mailer) {
    try {
      const deliveryText = process.env.DELIVERY_INSTRUCTIONS?.trim() ||
        "Seu pagamento foi confirmado. Entre em contato com o suporte da BATMAN CHEATS para receber as instruções de entrega.";
      await mailer.sendMail({
        from: requireEnv("EMAIL_FROM"),
        to: order.customer_email,
        subject: `Pagamento confirmado — pedido ${id}`,
        text: `Olá, ${order.customer_name}!\n\nConfirmamos manualmente o pagamento do seu pedido na BATMAN CHEATS.\nProduto: ${order.product}\nValor: ${centsToBRL(order.amount_cents)}\nPedido: ${id}\n\nInstruções de entrega:\n${deliveryText}\n\nSe precisar de ajuda, responda a este e-mail.`
      });
      db.prepare("UPDATE orders SET email_sent_at = ? WHERE id = ?").run(new Date().toISOString(), id);
    } catch (err) {
      console.error("Falha no e-mail de entrega:", err.message);
      return res.json({ ok: true, warning: "Pagamento marcado como confirmado, mas o e-mail falhou. Confira SMTP e reenvie manualmente." });
    }
  }
  res.json({ ok: true, message: mailer ? "Pagamento confirmado; e-mail de confirmação enviado." : "Pagamento confirmado. SMTP ainda não configurado; nenhum e-mail foi enviado." });
});

app.post("/api/admin/logout", adminAuth, (req, res) => {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  db.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").run(hash);
  res.json({ ok: true });
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.listen(port, () => console.log(`BATMAN CHEATS servidor ativo na porta ${port}`));
