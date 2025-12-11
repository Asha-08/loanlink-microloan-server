const express = require('express')
const cors = require('cors');
const app = express()
require('dotenv').config();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

const stripe = require('stripe')(process.env.STRIPE_SECRET);

const port = process.env.PORT || 3000


// middleware
app.use(express.json());
app.use(cors());


const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.us9qyhi.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});


async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db =  client.db('loan_link_db');
    const loansCollection = db.collection('loans');

    //  loans api
    app.get('/loans',async(req,res)=>{
        const query ={}
        const {email} = req.query;
        if(email){
          query.email = email;
        }

        const cursor = loansCollection.find(query);
        const result = await cursor.toArray();
        res.send(result)
    })

    app.get('/loans/:id',async(req,res)=>{
      const id = req.params.id;
      const query = {_id:new ObjectId(id)}
      const result = await loansCollection.findOne(query);
      res.send(result);
    })

    app.post('/loans',async(req,res)=>{
        const loan = req.body;
        const result = await loansCollection.insertOne(loan);
        res.send(result)
    })


    app.delete('/loans/:id',async(req,res)=>{
      const id = req.params.id;
      const query = {_id: new ObjectId(id)}

      const result = await loansCollection.deleteOne(query);
      res.send(result);
    })

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

   app.patch("/payment-success",async(req,res)=>{
    const sessionId = req.query.session_id;
    
      const session = await stripe.checkout.sessions.retrieve(sessionId);

      console.log('session retrieve', session)

      if(session.payment_status === 'paid'){
        const id = session.metadata.loanId;
        const query = {_id: new ObjectId(id)}
        const update = {
          $set:{
            applicationFeeStatus:'paid'
          }
        }
        const result = await loansCollection.updateOne(query,update);
        res.send(result)
      }

    res.send({success:false})



   })



    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);



app.get('/', (req, res) => {
  res.send('loanlink microloan server side running')
})

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})
