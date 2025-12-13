const express = require("express");
const cors = require("cors");
const app = express();
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const stripe = require("stripe")(process.env.STRIPE_SECRET);

const port = process.env.PORT || 3000;

const admin = require("firebase-admin");

const serviceAccount = require("./loanlink-microloan-firebase-adminsdk.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// middleware
app.use(express.json());
app.use(cors());

const verifyFBToken = async (req, res, next) => {
  const token = req.headers.authorization;

  if (!token) {
    return res.status(401).send({ message: "unathorized access" });
  }

  try {
    const idToken = token.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    console.log("decoded in the token", decoded);
    req.decoded_email = decoded.email;
    next();
  } catch (err) {
    return res.status(401).send({ message: "unathurized access" });
  }
};

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.us9qyhi.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db("loan_link_db");
    const loansCollection = db.collection("loans");
    const paymentCollection = db.collection("payments");
    const userCollection = db.collection("users");

    // must be used after verfyFbToken middleware
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email };
      const user = await userCollection.findOne(query);
      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };

    // user related api

    app.get("/users", verifyFBToken, verifyAdmin, async (req, res) => {
      const result = await userCollection.find().toArray();
      res.send(result);
    });

    // get role
    app.get("/users/:email/role", async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = await userCollection.findOne(query);
      res.send({ role: user?.role || "user" });
    });

    app.post("/users", async (req, res) => {
      const user = req.body;
      user.role = "user";
      user.requestedRole = user.requestedRole || null;
      user.status = "pending";
      user.createdAt = new Date();
      const email = user.email;
      const userExist = await userCollection.findOne({ email });

      if (userExist) {
        return res.send({
          message: "user exist",
          existing: true,
          user: userExist,
        });
      }

      const result = await userCollection.insertOne(user);
      res.send({
        existing: false,
        user: result,
      });
    });

    // for social login user api
    app.patch("/users/request-role/:email", async (req, res) => {
      const email = req.params.email;
      const { requestedRole } = req.body;

      const result = await userCollection.updateOne(
        { email },
        { $set: { requestedRole } }
      );

      res.send(result);
    });

    // update user role

    app.patch("/users/:id", verifyFBToken, verifyAdmin, async (req, res) => {
      const status = req.body.status;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };

      const user = await userCollection.findOne(query);
      if (!user) return res.status(404).send({ message: "User not found" });

      const updatedDoc = {
        $set: {
          status: status,
          role: user.requestedRole || user.role,
          requestedRole: null,
        },
      };
      const result = await userCollection.updateOne(query, updatedDoc);
      res.send(result);
    });

    // suspend user api

    app.patch(
      "/users/suspend/:id",verifyFBToken,verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const { reason, feedback } = req.body;

        const result = await userCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              status: "suspended",
              role: "user",
              suspendReason: reason,
              suspendFeedback: feedback,
            },
          }
        );

        res.send(result);
      }
    );

    //  loans api
    app.get("/loans", async (req, res) => {
      const query = {};
      const { email } = req.query;
      if (email) {
        query.email = email;
      }

      const cursor = loansCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get("/loans/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await loansCollection.findOne(query);
      res.send(result);
    });

    app.post("/loans", async (req, res) => {
      const loan = req.body;
      const result = await loansCollection.insertOne(loan);
      res.send(result);
    });

    app.delete("/loans/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };

      const result = await loansCollection.deleteOne(query);
      res.send(result);
    });

    // payment checkout session

    // new

    app.post("/payment-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      const amount = parseInt(paymentInfo.cost) * 100;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: amount,
              product_data: {
                name: `Please pay for: ${paymentInfo.loanTitle}`,
              },
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        metadata: {
          loanId: paymentInfo.loanId,
          loanTitle: paymentInfo.loanTitle,
          // trackingId: paymentInfo.trackingId,
        },
        customer_email: paymentInfo.email,
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
      });

      res.send({ url: session.url });
    });

    // old

    // app.post('/create-checkout-session', async (req, res) =>{
    //   const paymentInfo = req.body;
    //   const amount = parseInt(paymentInfo.cost) * 100;
    //  const session = await stripe.checkout.sessions.create({
    //    line_items: [
    //             {
    //                 price_data: {
    //                     currency: 'USD',
    //                     unit_amount: amount,
    //                     product_data: {
    //                         name: `Please pay for: ${paymentInfo.loanTitle}`
    //                     }
    //                 },
    //                 quantity: 1,
    //             },
    //         ],
    //         customer_email: paymentInfo.email,
    //         mode:'payment',
    //          metadata: {
    //             loanId: paymentInfo.loanId,
    //             loanTitle: paymentInfo.loanTitle
    //         },

    //         success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success`,
    //         cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,

    //  })

    //  console.log(session)
    //  res.send({ url: session.url })

    // })

    // payment success

    app.patch("/payment-success", async (req, res) => {
      const sessionId = req.query.session_id;

      const session = await stripe.checkout.sessions.retrieve(sessionId);

      // console.log('session retrieve', session)
      const transactionId = session.payment_intent;
      const query = { transactionId: transactionId };

      const paymentExist = await paymentCollection.findOne(query);

      console.log(paymentExist);
      if (paymentExist) {
        return res.send({
          message: "already exists",
          transactionId,
          // trackingId: paymentExist.trackingId,
        });
      }

      if (session.payment_status === "paid") {
        const id = session.metadata.loanId;
        const query = { _id: new ObjectId(id) };
        const update = {
          $set: {
            applicationFeeStatus: "paid",
          },
        };
        const result = await loansCollection.updateOne(query, update);
        // res.send(result)

        const payment = {
          amount: session.amount_total / 100,
          currency: session.currency,
          customerEmail: session.customer_email,
          loanId: session.metadata.loanId,
          loanTitle: session.metadata.loanTitle,
          transactionId: session.payment_intent,
          paymentStatus: session.payment_status,
          paidAt: new Date(),
          // trackingId: trackingId,
        };

        if (session.payment_status === "paid") {
          const resultPayment = await paymentCollection.insertOne(payment);

          res.send({
            success: true,
            modifyLoan: result,
            paymentInfo: resultPayment,
            transactionId: session.payment_intent,
          });
        }
      }

      res.send({ success: false });
    });

    //  payment related apis
    app.get("/payments", verifyFBToken, async (req, res) => {
      const email = req.query.email;
      const loanId = req.query.loanId;
      const query = {};

      // console.log('headers',req.headers);

      if (email) {
        query.customerEmail = email;

        // check email address
        if (email !== req.decoded_email) {
          return res.status(403).send({ message: "forbidden access" });
        }
      }

      if (loanId) {
        query.loanId = loanId;
      }

      const cursor = paymentCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("loanlink microloan server side running");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
