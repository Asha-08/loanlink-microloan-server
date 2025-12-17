const express = require("express");
const cors = require("cors");
const app = express();
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const stripe = require("stripe")(process.env.STRIPE_SECRET);

const port = process.env.PORT || 3000;

const admin = require("firebase-admin");

// const serviceAccount = require("./loanlink-microloan-firebase-adminsdk.json");

const decoded = Buffer.from(process.env.FB_SECRET_KEY, 'base64').toString('utf8')
const serviceAccount = JSON.parse(decoded);


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
    const addLoansCollection = db.collection("addloans");

    // must be used after verifyFbToken middleware
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email };
      const user = await userCollection.findOne(query);
      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };

    // Manager token

    const verifyManager = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email };
      const user = await userCollection.findOne(query);
      if (!user || user.role !== "manager") {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };

    // verify admin or manager

    const verifyAdminOrManager = async (req, res, next) => {
      const email = req.decoded_email;

      const user = await userCollection.findOne({ email });

      if (user?.role === "admin" || user?.role === "manager") {
        next();
      } else {
        res.status(403).send({ message: "Forbidden Access" });
      }
    };

    // verifyUser or borrower
    const verifyUserOrBorrower = async (req, res, next) => {
      const email = req.decoded_email;

      const user = await userCollection.findOne({ email });

      if (user?.role === "user" || user?.role === "borrower") {
        next();
      } else {
        res.status(403).send({ message: "Forbidden Access" });
      }
    };

    // user related api

    app.get("/users", verifyFBToken, verifyAdmin, async (req, res) => {
      const { searchText, role, status } = req.query;
      const query = {};
      if (searchText) {
        query.$or = [
          { displayName: { $regex: searchText, $options: "i" } },
          { email: { $regex: searchText, $options: "i" } },
        ];
      }

      // filter by role
      if (role) {
        query.role = role;
      }

      // filter by status
      if (status) {
        query.status = status;
      }

      const result = await userCollection
        .find(query)
        .sort({ createdAt: 1 })
        .toArray();

      res.send(result);
    });

    // get role
    app.get("/users/:email/role", async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = await userCollection.findOne(query);
      res.send({ role: user?.role || "user" });
    });

    // get user data for profile
    

    app.get("/users/profile/:email", verifyFBToken, async (req, res) => {
      const { email } = req.params;
      const user = await userCollection.findOne({ email });

      if (!user) {
        return res.status(404).send({ message: "User not found" });
      }

      return res.send(user);
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
      "/users/suspend/:id",
      verifyFBToken,
      verifyAdmin,
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
      const { email, status } = req.query;
      if (email) {
        query.email = email;
      }

      if (status) {
        query.status = status;
      }

      const cursor = loansCollection.find(query);
      const result = await cursor.toArray();
       return res.send(result);
    });

    app.get("/loans/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await loansCollection.findOne(query);
      res.send(result);
    });

    app.post("/loans",verifyFBToken,verifyUserOrBorrower, async (req, res) => {
      const loan = req.body;
      const result = await loansCollection.insertOne(loan);
      return res.send(result);
    });

    app.patch(
      "/loans/:id/status",
      verifyFBToken,
      verifyManager,
      async (req, res) => {
        const { id } = req.params;
        const { status } = req.body;

        if (!["approved", "rejected"].includes(status)) {
          return res.status(400).send({ message: "Invalid Status" });
        }

        const loan = await loansCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!loan) {
          return res.status(404).send({ message: "loan not found" });
        }

        if (loan.status === "approved") {
          return res.status(400).send({ message: "Loan already approved" });
        }

        const updateData = { status };

        if (status === "approved") {
          updateData.approveAt = new Date();
          updateData.approvedBy = req.decoded.email;
        }

        const result = await loansCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updateData }
        );

        return res.send(result);
      }
    );

    app.delete("/loans/:id",verifyFBToken,verifyUserOrBorrower, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };

      const result = await loansCollection.deleteOne(query);
      res.send(result);
    });

    // add Loans api from manager side

    // POST: Add Loan
    app.post("/addloans", async (req, res) => {
      try {
        const loanData = req.body;

        // basic validation
        if (
          !loanData.title ||
          !loanData.category ||
          !loanData.interestRate ||
          !loanData.maxLoanLimit ||
          !loanData.image
        ) {
          return res.status(400).send({ message: "Required fields missing" });
        }

        const newLoan = {
          title: loanData.title,
          description: loanData.description || "",
          category: loanData.category,
          interestRate: loanData.interestRate,
          maxLoanLimit: loanData.maxLoanLimit,
          requiredDocuments: loanData.requiredDocuments || "",
          emiPlans: loanData.emiPlans || "",
          image: loanData.image,
          showOnHome: loanData.showOnHome || false,
          createdBy: {
            email: loanData.createdBy.email,
            name: loanData.createdBy.name || "Unknown",
          },
          createdAt: new Date(),
        };

        const result = await addLoansCollection.insertOne(newLoan);

        return res.send({
          success: true,
          insertedId: result.insertedId,
        });
      } catch (error) {
        console.error(error);
        return res.status(500).send({ message: "Failed to add loan" });
      }
    });

    // get add loan

    app.get("/addloans", async (req, res) => {
      const { search } = req.query;

      let query = {};

      if (search) {
        query = {
          $or: [
            { title: { $regex: search, $options: "i" } },
            { category: { $regex: search, $options: "i" } },
          ],
        };
      }

      const result = await addLoansCollection.find(query).toArray();
      res.send(result);
    });

    // show on home available section
   app.get("/addloans/home", async (req, res) => {
  const loans = await addLoansCollection.find({showOnHome: true}).limit(6).toArray();
  
  return res.send(loans);
});


    app.get("/addloans/:id", async (req, res) => {
      const { id } = req.params;

      const query = { _id: new ObjectId(id) };
      const result = await addLoansCollection.findOne(query);

      return res.send(result);
    });

    // Toggle showOnHome
    app.patch("/addloans/:id/showOnHome", async (req, res) => {
      const { id } = req.params;
      const { showOnHome } = req.body;

      const filter = { _id: new ObjectId(id) };
      const updateDoc = { $set: { showOnHome } };

      const result = await addLoansCollection.updateOne(filter, updateDoc);
      return res.send(result);
    });

    // delete add loans

    app.delete(
      "/addloans/:id",
      verifyFBToken,
      verifyAdminOrManager,
      async (req, res) => {
        try {
          const { id } = req.params;

          const result = await addLoansCollection.deleteOne({
            _id: new ObjectId(id),
          });

          if (result.deletedCount === 0) {
            return res.status(404).send({ message: "Loan not found" });
          }

          res.send({
            success: true,
            message: "Loan deleted successfully",
          });
        } catch (error) {
          console.error("Delete loan error:", error);
          return res.status(500).send({ message: "Failed to delete loan" });
        }
      }
    );

    // update from admin and manager

    app.patch(
      "/addloans/:id",
      verifyFBToken,
      verifyAdminOrManager,
      async (req, res) => {
        const { id } = req.params;
        const updatedLoan = req.body;

        const result = await addLoansCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              title: updatedLoan.title,
              description: updatedLoan.description,
              interestRate: updatedLoan.interestRate,
              category: updatedLoan.category,
              image: updatedLoan.image,
              maxLoanLimit: updatedLoan.maxLoanLimit,
              emiPlans: updatedLoan.emiPlans,
              updatedAt: new Date(),
            },
          }
        );

        res.send(result);
      }
    );

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
            status: "pending",
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
    // await client.db("admin").command({ ping: 1 });
    // console.log(
    //   "Pinged your deployment. You successfully connected to MongoDB!"
    // );
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
