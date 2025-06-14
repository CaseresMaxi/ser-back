require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MercadoPagoConfig, Preference } = require("mercadopago");
const admin = require("firebase-admin");

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

// Initialize Firebase Admin
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
  });
}

// Create payment preference
app.post("/api/create-payment", async (req, res) => {
  console.log("BODY RECIBIDO:", req.body, process.env.SUCCESS_URL);
  try {
    const { title, price, quantity, user_id, plan_id, user_email } = req.body;
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
        payer: user_email ? { email: user_email } : undefined,
        metadata: {
          user_id,
          plan_id,
        },
        back_urls: {
          success: process.env.SUCCESS_URL,
          failure: process.env.FAILURE_URL,
          pending: process.env.PENDING_URL,
        },
        auto_return: "approved",
        notification_url: `${process.env.BASE_URL}/api/webhook`,
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
    const { type, data } = req.body;

    if (type === "payment") {
      const paymentId = data.id;

      // Get payment details from MercadoPago
      const payment = await client.payment.get({ id: paymentId });

      if (payment.status === "approved") {
        // Get the user ID from the payment metadata
        const userId = payment.metadata?.user_id;
        const planId = payment.metadata?.plan_id;

        if (userId && planId) {
          // Create subscription and record payment
          const subscriptionData = {
            userId,
            planId,
            status: "active",
            paymentId,
            createdAt: new Date(),
            updatedAt: new Date(),
          };

          // Update subscription in database
          await admin
            .firestore()
            .collection("subscriptions")
            .doc(userId)
            .set(subscriptionData, { merge: true });

          // Record payment in database
          await admin.firestore().collection("payments").add({
            userId,
            planId,
            paymentId,
            amount: payment.transaction_amount,
            currency: payment.currency_id,
            status: "completed",
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        }
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Error processing webhook:", error);
    res.sendStatus(500);
  }
});

app.get("/", (req, res) => {
  res.send("Hello World");
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
