require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MercadoPagoConfig, Preference, Payment } = require("mercadopago");
const admin = require("firebase-admin");

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(
  cors({
    origin: "*",
    credentials: true,
  })
);
app.use(express.json());

// Configure Mercado Pago
const client = new MercadoPagoConfig({
  accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN,
});
const preference = new Preference(client);
const payment = new Payment(client);

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
  console.log("BODY RECIBIDO:", req.body);
  try {
    const { title, price, quantity, user_id, plan_id, user_email } = req.body;

    if (!user_id || !plan_id || !user_email) {
      return res
        .status(400)
        .json({
          error: "Missing required fields: user_id, plan_id, user_email",
        });
    }

    console.log("Creating payment for:", {
      user_id,
      plan_id,
      user_email,
      price,
    });

    const response = await preference.create({
      body: {
        items: [
          {
            title: title || "Plan Premium",
            unit_price: Number(price),
            quantity: Number(quantity) || 1,
            currency_id: "ARS",
          },
        ],
        payer: {
          email: user_email,
        },
        metadata: {
          user_id,
          plan_id,
          user_email,
        },
        back_urls: {
          success: `${process.env.BASE_URL}/api/register-payment?payment_id={payment_id}&status={status}&merchant_order_id={merchant_order_id}&user_id=${user_id}&plan_id=${plan_id}&user_email=${user_email}`,
          failure: process.env.FAILURE_URL,
          pending: process.env.PENDING_URL,
        },
        auto_return: "approved",
        notification_url: `${process.env.BASE_URL}/api/webhook`,
      },
    });

    console.log("Payment preference created:", response.id);
    res.json({
      id: response.id,
      init_point: response.init_point,
    });
  } catch (error) {
    console.error("Error creating payment:", error);
    res.status(500).json({ error: error.message });
  }
});

// Function to save payment to Firebase
async function savePaymentToFirebase(paymentData, source = "webhook") {
  try {
    console.log(`Saving payment to Firebase from ${source}:`, paymentData);

    const {
      user_id,
      plan_id,
      user_email,
      payment_id,
      status,
      amount,
      currency,
      merchant_order_id,
      transaction_id,
    } = paymentData;

    if (!user_id || !plan_id) {
      console.error("Missing required data for Firebase:", {
        user_id,
        plan_id,
      });
      return false;
    }

    // Define plan names
    const planNames = {
      basic: "Plan Básico",
      premium: "Plan Premium",
      professional: "Plan Profesional",
    };

    // Payment document data
    const paymentDoc = {
      userId: user_id,
      userEmail: user_email || null,
      planId: plan_id,
      planName: planNames[plan_id] || "Plan Desconocido",
      amount: Number(amount) || 0,
      currency: currency || "ARS",
      status: status === "approved" ? "completed" : status || "pending",
      paymentMethod: "mercadopago",
      transactionId: transaction_id || payment_id,
      mercadopagoPaymentId: payment_id,
      mercadopagoOrderId: merchant_order_id || null,
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: {
        merchant_order_id: merchant_order_id,
        payment_id: payment_id,
        paymentMethod: "mercadopago",
        status: status,
        transactionId: transaction_id || payment_id,
      },
    };

    // Save payment
    await admin.firestore().collection("payments").add(paymentDoc);
    console.log("Payment saved successfully to Firebase");

    // Update subscription if payment is approved
    if (status === "approved" || status === "completed") {
      const subscriptionData = {
        userId: user_id,
        userEmail: user_email || null,
        planId: plan_id,
        planName: planNames[plan_id] || "Plan Desconocido",
        status: "active",
        paymentId: payment_id,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await admin
        .firestore()
        .collection("subscriptions")
        .doc(user_id)
        .set(subscriptionData, { merge: true });

      console.log("Subscription updated successfully");
    }

    return true;
  } catch (error) {
    console.error("Error saving to Firebase:", error);
    return false;
  }
}

// Webhook to handle payment notifications
app.post("/api/webhook", async (req, res) => {
  try {
    console.log("Webhook received:", req.body);
    const { type, data } = req.body;

    if (type === "payment") {
      const paymentId = data.id;
      console.log("Processing payment notification:", paymentId);

      try {
        // Get payment details from MercadoPago using the Payment class
        const paymentResponse = await payment.get({ id: paymentId });
        console.log("Payment details from MercadoPago:", paymentResponse);

        if (paymentResponse) {
          const paymentData = {
            user_id: paymentResponse.metadata?.user_id,
            plan_id: paymentResponse.metadata?.plan_id,
            user_email:
              paymentResponse.metadata?.user_email ||
              paymentResponse.payer?.email,
            payment_id: paymentResponse.id,
            status: paymentResponse.status,
            amount: paymentResponse.transaction_amount,
            currency: paymentResponse.currency_id,
            merchant_order_id: paymentResponse.order?.id,
            transaction_id: paymentResponse.id,
          };

          await savePaymentToFirebase(paymentData, "webhook");
        }
      } catch (mpError) {
        console.error("Error getting payment from MercadoPago:", mpError);
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Error processing webhook:", error);
    res.sendStatus(500);
  }
});

// Endpoint para registrar pago desde el frontend tras redirección exitosa
app.get("/api/register-payment", async (req, res) => {
  try {
    console.log("Register payment endpoint called with:", req.query);
    const {
      payment_id,
      status,
      merchant_order_id,
      user_id,
      plan_id,
      user_email,
    } = req.query;

    if (!payment_id || !user_id || !plan_id) {
      return res
        .status(400)
        .json({
          error: "Missing required params: payment_id, user_id, plan_id",
        });
    }

    // Try to get additional payment info from MercadoPago
    let amount = 0;
    let currency = "ARS";

    try {
      const paymentResponse = await payment.get({ id: payment_id });
      if (paymentResponse) {
        amount = paymentResponse.transaction_amount || 0;
        currency = paymentResponse.currency_id || "ARS";
      }
    } catch (mpError) {
      console.warn(
        "Could not get payment details from MercadoPago:",
        mpError.message
      );
    }

    const paymentData = {
      user_id,
      plan_id,
      user_email,
      payment_id,
      status: status || "completed",
      amount,
      currency,
      merchant_order_id,
      transaction_id: payment_id,
    };

    const saved = await savePaymentToFirebase(paymentData, "frontend");

    if (saved) {
      res.json({ success: true, message: "Payment registered successfully" });
    } else {
      res.status(500).json({ error: "Failed to save payment to Firebase" });
    }
  } catch (error) {
    console.error("Error registering payment from frontend:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/", (req, res) => {
  res.send("Hello World");
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
