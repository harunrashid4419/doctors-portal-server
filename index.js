const express = require("express");
const cors = require("cors");
require("dotenv").config();
const nodemailer = require('nodemailer');
const mg = require('nodemailer-mailgun-transport');
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const jwt = require("jsonwebtoken");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const port = process.env.PORT || 5000;
const app = express();

app.use(cors());
app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.uqseuad.mongodb.net/?retryWrites=true&w=majority`;
const client = new MongoClient(uri, {
   useNewUrlParser: true,
   useUnifiedTopology: true,
   serverApi: ServerApiVersion.v1,
});

function sendBookingEmail(booking){
   const {email, treatment, slot, appointDate} = booking;

   const auth = {
      auth: {
        api_key: process.env.SEND_MAIL_KEY,
        domain: process.env.SEND_MAIL_DOMAIN
      }
    }
    
    const transporter = nodemailer.createTransport(mg(auth));


   // let transporter = nodemailer.createTransport({
   //    host: 'smtp.sendgrid.net',
   //    port: 587,
   //    auth: {
   //        user: "apikey",
   //        pass: process.env.SENDGRID_API_KEY
   //    }
   // })

   console.log('email send', email);
   transporter.sendMail({
      from: "harunrashid4419@gmail.com", // verified sender email
      to: email || 'harunrashid4419@gmail.com', // recipient email
      subject: `You appointment for ${treatment} is confirmed.`, // Subject line
      text: "Hello world!", // plain text body
      html: `
      <h3>Your appointment is confirmed</h3>
      <div>
         <p>Your appointment for treatment ${treatment}</p>
         <p>Please visit us on ${appointDate} at ${slot}</p>
         <p>Thanks for Doctor portal</p>
      </div>
      `, // html body
    }, function(error, info){
      if (error) {
        console.log(error);
      } else {
        console.log('Email sent: ' + info.response);
      }
    });
}


function verifyJWT(req, res, next) {
   const authHeaders = req.headers.authorization;
   if (!authHeaders) {
      return res.status(401).send("unauthorized access");
   }
   const token = authHeaders.split(" ")[1];

   jwt.verify(token, process.env.ACCESS_TOKEN, function (err, decoded) {
      if (err) {
         return res.status(403).send({ message: "forbidden access" });
      }
      req.decoded = decoded;
      next();
   });
}

async function run() {
   try {
      const appointmentCollections = client
         .db("doctorsPortalRecap")
         .collection("appointment");
      const bookingCollections = client
         .db("doctorsPortalRecap")
         .collection("booking");
      const usersCollections = client
         .db("doctorsPortalRecap")
         .collection("users");
      const doctorsCollections = client
         .db("doctorsPortalRecap")
         .collection("doctors");
      const paymentsCollections = client
         .db("doctorsPortalRecap")
         .collection("payments");

      const verifyAdmin = async (req, res, next) => {
         const decodedEmail = req.decoded.email;
         const query = { email: decodedEmail };
         const user = await usersCollections.findOne(query);
         if (user?.role !== "admin") {
            return res.status(403).send({ message: "forbidden access" });
         }
         next();
      };

      // get all appointment
      app.get("/appointment", async (req, res) => {
         const date = req.query.date;
         const query = {};
         const options = await appointmentCollections.find(query).toArray();

         const bookingQuery = { appointDate: date };
         const alreadyBooked = await bookingCollections
            .find(bookingQuery)
            .toArray();

         options.forEach((option) => {
            const optionBooked = alreadyBooked.filter(
               (book) => book.treatment === option.name
            );
            const bookedSlots = optionBooked.map((book) => book.slot);
            const remainingSlots = option.slots.filter(
               (slot) => !bookedSlots.includes(slot)
            );
            option.slots = remainingSlots;
         });
         res.send(options);
      });

      //    get specific users bookings
      app.get("/bookings", verifyJWT, async (req, res) => {
         const email = req.query.email;
         const decodedEmail = req.decoded.email;
         if (email !== decodedEmail) {
            return res.status(403).send("forbidden access");
         }
         const query = { email: email };
         const result = await bookingCollections.find(query).toArray();
         res.send(result);
      });

      // get specific booking by id
      app.get("/bookings/:id", async (req, res) => {
         const id = req.params.id;
         const query = { _id: ObjectId(id) };
         const result = await bookingCollections.findOne(query);
         res.send(result);
      });

      // get booking
      app.post("/bookings", async (req, res) => {
         const booking = req.body;
         const query = {
            appointDate: booking.appointDate,
            email: booking.email,
            treatment: booking.treatment,
         };
         const alreadyBooked = await bookingCollections.find(query).toArray();
         if (alreadyBooked.length) {
            const message = `You have already booking on ${booking.appointDate}`;
            return res.send({ acknowledged: false, message });
         }

         const result = await bookingCollections.insertOne(booking);
         sendBookingEmail(booking);
         res.send(result);
      });

      // stripe payment method
      app.post("/create-payment-intent", async (req, res) => {
         const booking = req.body;
         const price = booking.price;
         const amount = price * 100;
         const paymentIntent = await stripe.paymentIntents.create({
            amount: amount,
            currency: "usd",
            payment_method_types: ["card"],
         });
         res.send({
            clientSecret: paymentIntent.client_secret,
         });
      });

      // payment information store in database
      app.post('/payments', async(req, res) =>{
         const booking = req.body;
         const result = await paymentsCollections.insertOne(booking);
         const id = booking.bookingId;
         const filter = {_id: ObjectId(id)};
         const updateDoc = {
            $set:{
               paid: true,
               transitionId: booking.transitionId
            }
         }
         const updatedResult = await bookingCollections.updateOne(filter, updateDoc);
         res.send(result);
      })

      // jwt token
      app.get("/jwt", async (req, res) => {
         const email = req.query.email;
         const query = { email: email };
         const user = await usersCollections.findOne(query);
         if (user) {
            const token = jwt.sign({ email }, process.env.ACCESS_TOKEN, {
               expiresIn: "1h",
            });
            return res.send({ accessToken: token });
         }
         res.status(403).send({ accessToken: "" });
      });

      //    get users
      app.post("/users", async (req, res) => {
         const user = req.body;
         const result = await usersCollections.insertOne(user);
         res.send(result);
      });

      // load all users
      app.get("/users", async (req, res) => {
         const users = {};
         const result = await usersCollections.find(users).toArray();
         res.send(result);
      });

      // specif user
      app.get("/users/admin/:email", async (req, res) => {
         const email = req.params.email;
         const query = { email };
         const user = await usersCollections.findOne(query);
         res.send({ isAdmin: user?.role === "admin" });
      });

      // update admin role
      app.put("/users/admin/:id", verifyJWT, verifyAdmin, async (req, res) => {
         const id = req.params.id;
         const filter = { _id: ObjectId(id) };
         const option = { upsert: true };
         const updatedDoc = {
            $set: {
               role: "admin",
            },
         };
         const result = await usersCollections.updateOne(
            filter,
            updatedDoc,
            option
         );
         res.send(result);
      });

      // app.get('/addPrice', async(req, res) =>{
      //    const filter = {};
      //    const option = {upsert: true};
      //    const updatedPrice = {
      //       $set: {
      //          price: 99
      //       }
      //    };
      //    const result = await appointmentCollections.updateMany(filter, updatedPrice, option);
      //    res.send(result);
      // })

      // get booking all name
      app.get("/bookingSpecialty", async (req, res) => {
         const query = {};
         const result = await appointmentCollections
            .find(query)
            .project({ name: 1 })
            .toArray();
         res.send(result);
      });

      // create doctors
      app.post("/doctors", verifyJWT, verifyAdmin, async (req, res) => {
         const query = req.body;
         const doctors = await doctorsCollections.insertOne(query);
         res.send(doctors);
      });

      // get all doctors
      app.get("/doctors", verifyJWT, verifyAdmin, async (req, res) => {
         const query = {};
         const result = await doctorsCollections.find(query).toArray();
         res.send(result);
      });

      // delete a doctors
      app.delete("/doctors/:id", verifyJWT, verifyAdmin, async (req, res) => {
         const id = req.params.id;
         const query = { _id: ObjectId(id) };
         const result = await doctorsCollections.deleteOne(query);
         res.send(result);
      });
   } finally {
   }
}

run().catch((error) => console.error(error));

app.get("/", (req, res) => {
   res.send("doctors portal is running");
});

app.listen(port, () => console.log(`port is running on ${port}`));
