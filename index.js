require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MercadoPagoConfig, Preference } = require("mercadopago");

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(
  cors({
    origin: "http://localhost:5173",
    credentials: true,
  })
);
app.use(express.json());

// Configure Mercado Pago
const client = new MercadoPagoConfig({
  accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN,
});
const preference = new Preference(client);

// Create payment preference
app.post("/api/create-payment", async (req, res) => {
  console.log("BODY RECIBIDO:", req.body, process.env.SUCCESS_URL);
  try {
    const { title, price, quantity } = req.body;
    console.log("BACK_URLS:", {
      success: process.env.SUCCESS_URL,
      failure: process.env.FAILURE_URL,
      pending: process.env.PENDING_URL,
    });
    const response = await preference.create({
      body: {
        items: [
          {
            title: title,
            unit_price: Number(price),
            quantity: Number(quantity),
            currency_id: "ARS",
          },
        ],
        back_urls: {
          success: process.env.SUCCESS_URL,
          failure: process.env.FAILURE_URL,
          pending: process.env.PENDING_URL,
        },
        auto_return: "approved",
      },
    });
    res.json({
      id: response.id,
      init_point: response.init_point,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// Webhook to handle payment notifications
app.post("/api/webhook", async (req, res) => {
  try {
    // Aquí puedes manejar la notificación del pago
    console.log("Webhook recibido:", req.body);
    res.sendStatus(200);
  } catch (error) {
    console.error(error);
    res.sendStatus(500);
  }
});

app.get("/", (req, res) => {
  res.send("Hello World");
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
