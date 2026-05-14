const express = require("express")
const cors = require("cors")
require("dotenv").config()
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const crypto = require("crypto")
const admin = require("firebase-admin");


const serviceAccount = require("./firebase-adminsdk.json");

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});


const stripe = require('stripe')(process.env.STRIPE_secret)

const port = process.env.PORT || 3000;

const app = express()

function generateTrackingId() {
    const prefix = 'PRCL'
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const random = crypto.randomBytes(3).toString("hex").toUpperCase()
    return `${prefix}-${date}-${random}`
}

app.use(cors())
app.use(express.json())


const verifyFirebaseToken = async (req, res, next) => {

    const token = req.headers.authorization

    if (!token) {
        return res.status(401)
            .send({ message: 'Unauthorized Access' })
    }

    try {
        const idToken = token.split(' ')[1];
        const decoded = await admin.auth().verifyIdToken(idToken)
        req.decoded_email = decoded.email
        next()
    } catch (error) {
        return res.status(401).send({ message: "Unauthorized Access" })
    }

}


app.get("/", (req, res) => {
    res.send("swift move server is running")
})



const uri = `mongodb+srv://${process.env.DB_user}:${process.env.DB_pass}@cluster0.b7lw2.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        await client.connect();

        const db = client.db("swift_move_db")

        const usersCollection = db.collection("users")
        const ridersCollection = db.collection("riders")
        const parcelsCollection = db.collection("parcels")
        const paymentsCollection = db.collection("payments")
        const trackingsCollection = db.collection("trackings")



        const verifyAdmin = async (req, res, next) => {
            const email = req.decoded_email
            const query = { email }
            const user = await usersCollection.findOne(query)

            if (!user || user.role !== 'admin') {
                return res.status(403).send({ message: "Forbidden Access" })
            }
            next()
        }



        const verifyRider = async (req, res, next) => {
            const email = req.decoded_email
            const query = { email }
            const user = await usersCollection.findOne(query)

            if (!user || user.role !== 'rider') {
                return res.status(403).send({ message: "Forbidden Access" })
            }
            next()
        }


        const logTracking = async (trackingId, status) => {
            const log = {
                trackingId,
                status,
                details: status.split('_').join(" "),
                createdAt: new Date()
            }

            const result = await trackingsCollection.insertOne(log)
            return result
        }



        // PARCEL API
        app.get("/parcels", async (req, res) => {
            const query = {}

            const { email, deliveryStatus } = req.query;
            if (email) {
                query.senderEmail = email
            }

            if (deliveryStatus) {
                query.deliveryStatus = deliveryStatus
            }

            const parcels = await parcelsCollection.find(query).sort({ createdAt: -1 })
            const result = await parcels.toArray()
            res.send(result)
        })

        app.get('/active-parcels', verifyFirebaseToken, async (req, res) => {
            const email = req.decoded_email;

            const activeStatuses = [
                'pending-pickup',
                'rider_assigned',
                'in-transit'
            ];

            const result = await parcelsCollection
                .find({
                    senderEmail: email,
                    deliveryStatus: {
                        $in: activeStatuses
                    }

                })
                .toArray();
            res.send(result);
        })

        app.get("/parcels/rider", async (req, res) => {
            const { riderEmail, deliveryStatus } = req.query;

            const query = {}

            if (riderEmail) {
                query.riderEmail = riderEmail
            }

            if (deliveryStatus !== 'parcel_delivered') {
                query.deliveryStatus = { $nin: ['parcel_delivered'] }
            }

            else {
                query.deliveryStatus = deliveryStatus
            }

            const parcels = parcelsCollection.find(query)
            const result = await parcels.toArray()
            res.send(result)
        })

        app.get("/parcels/:id", async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) }
            const parcel = await parcelsCollection.findOne(query)
            res.send(parcel)
        })

        app.get('/parcels/delivery-status/stats', verifyFirebaseToken, async (req, res) => {
            const email = req.decoded_email;

            const userDoc = await usersCollection.findOne({ email });
            const role = userDoc?.role || 'user';

            let matchStage = {
                deliveryStatus: { $ne: null }
            };


            if (role !== 'admin') {
                matchStage.senderEmail = email;
            }


            const pipeline = [

                {
                    $match: matchStage
                },

                {
                    $group: {
                        _id: '$deliveryStatus',
                        count: {
                            $sum: 1
                        }
                    }
                }

            ];


            const result = await parcelsCollection
                .aggregate(pipeline)
                .toArray();


            res.send(result);
        })

        app.post("/parcels", async (req, res) => {
            const parcel = req.body;

            const trackingId = generateTrackingId()
            parcel.trackingId = trackingId

            await logTracking(trackingId, 'parcel_created')
            const result = await parcelsCollection.insertOne(parcel)
            res.send(result)
        })

        app.patch("/parcels/:id", async (req, res) => {
            const { riderId, riderName, riderEmail, trackingId } = req.body;
            const id = req.params.id;
            const query = { _id: new ObjectId(id) }

            const updateDoc = {
                $set: {
                    riderId: riderId,
                    riderName: riderName,
                    riderEmail: riderEmail,
                    deliveryStatus: "rider_assigned"
                }
            }

            const result = await parcelsCollection.updateOne(query, updateDoc)

            const riderQuery = { _id: new ObjectId(riderId) }
            const riderUpdateDoc = {
                $set: {
                    workStatus: 'in_delivery'
                }
            }
            const riderResult = await ridersCollection.updateOne(riderQuery, riderUpdateDoc)

            logTracking(trackingId, 'rider_assigned')

            res.send(riderResult)
        })

        app.patch("/parcels/:id/status", async (req, res) => {
            const { deliveryStatus, riderId, trackingId } = req.body
            const query = { _id: new ObjectId(req.params.id) }
            const updateDoc = {
                $set: {
                    deliveryStatus: deliveryStatus
                }
            }

            if (deliveryStatus === 'parcel_delivered') {
                const riderQuery = { _id: new ObjectId(riderId) }
                const riderUpdateDoc = {
                    $set: {
                        workStatus: 'available'
                    }
                }

                await ridersCollection.updateOne(riderQuery, riderUpdateDoc)
            }

            const result = await parcelsCollection.updateOne(query, updateDoc)

            logTracking(trackingId, deliveryStatus)

            res.send(result)
        })






        // PAYMENT API
        app.get("/payments", verifyFirebaseToken, async (req, res) => {
            const email = req.query.email;
            const query = {}

            if (email) {
                query.customerEmail = email
                if (email !== req.decoded_email) {
                    return res.status(401).send({ message: "Forbidden Access" })
                }
            }
            const payments = await paymentsCollection.find(query).sort({ paidAt: -1 })
            const result = await payments.toArray()
            res.send(result)
        })

        app.post('/create-checkout-session', async (req, res) => {
            const paymentInfo = req.body
            const amount = parseInt(paymentInfo.cost) * 100
            const session = await stripe.checkout.sessions.create({
                line_items: [
                    {

                        price_data: {
                            currency: 'USD',
                            unit_amount: amount,
                            product_data: {
                                name: paymentInfo.parcelName
                            }
                        },
                        quantity: 1,
                    },
                ],
                customer_email: paymentInfo.senderEmail,
                mode: 'payment',
                metadata: {
                    parcelId: paymentInfo.parcelId,
                    parcelName: paymentInfo.parcelName,
                    trackingId: paymentInfo.trackingId
                },
                success_url: `${process.env.SITE_domain}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${process.env.SITE_domain}/dashboard/payment-cancelled`,
            });

            res.send({ url: session.url })
        })

        app.patch('/payment-success', async (req, res) => {
            const sessionId = req.query.session_id;
            const session = await stripe.checkout.sessions.retrieve(sessionId)
            const transactionId = session.payment_intent
            const query = { transactionId: transactionId }
            const paymentExist = await paymentsCollection.findOne(query)
            if (paymentExist) {
                return res.send({
                    message: 'Payment already exist',
                    transactionId,
                    trackingId: paymentExist.trackingId
                })
            }

            const trackingId = session.metadata.trackingId

            if (session.payment_status === 'paid') {
                const id = session.metadata.parcelId;
                const query = { _id: new ObjectId(id) }
                const update = {
                    $set: {
                        paymentStatus: 'paid',
                        deliveryStatus: 'pending-pickup',
                    }
                }
                const result = await parcelsCollection.updateOne(query, update)

                const payment = {
                    amount: session.amount_total / 100,
                    currency: session.currency,
                    customerEmail: session.customer_email,
                    parcelId: session.metadata.parcelId,
                    transactionId: session.payment_intent,
                    paymentStatus: session.payment_status,
                    paidAt: new Date(),
                    trackingId: trackingId
                }

                const resultPayment = await paymentsCollection.insertOne(payment)

                logTracking(trackingId, 'pending-pickup')

                return res.send({
                    success: true,
                    modifyParcel: result,
                    trackingId: trackingId,
                    transactionId: session.payment_intent,
                    paymentInfo: resultPayment
                })

            }
            return res.send({ success: false })
        })




        // USERS API
        app.get("/users", async (req, res) => {
            const searchText = req.query.searchText
            const query = {}
            if (searchText) {

                query.$or = [
                    { displayName: { $regex: searchText, $options: 'i' } },
                    { email: { $regex: searchText, $options: 'i' } }
                ]
            }
            const users = await usersCollection.find(query).limit(6).sort({ createdAt: -1 })
            const result = await users.toArray()
            res.send(result)
        })


        app.get('/users/role-stats', async (req, res) => {

            const pipeline = [
                {
                    $group: {
                        _id: '$role',
                        count: {
                            $sum: 1
                        }
                    }
                }
            ];

            const result = await usersCollection
                .aggregate(pipeline)
                .toArray();


            res.send(result);
        })

        app.get("/users/:email/role", async (req, res) => {
            const email = req.params.email

            const quary = { email }
            const user = await usersCollection.findOne(quary)
            res.send({ role: user?.role || 'user' })
        })

        app.post("/users", async (req, res) => {
            const user = req.body;
            user.role = 'user'
            user.createdAt = new Date()

            const existUser = await usersCollection.findOne({ email: user.email })

            if (existUser) {
                return res.send({ message: "User already exist" })
            }

            const result = await usersCollection.insertOne(user)
            res.send(result)
        })

        app.patch("/users/:id/role", verifyFirebaseToken, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const role = req.body.role
            const quary = { _id: new ObjectId(id) }
            const updateDoc = {
                $set: {
                    role: role
                }
            }

            const result = await usersCollection.updateOne(quary, updateDoc)
            res.send(result)
        })




        // RIDERS API
        app.get('/riders', async (req, res) => {
            const { district, workStatus, status } = req.query

            const query = {}

            if (district) {
                query.district = district
            }

            if (status) {
                query.status = status
            } else {
                query.status = { $ne: 'pending' }
            }

            if (workStatus) {
                query.workStatus = workStatus
            }

            const result = await ridersCollection.find(query).toArray()
            res.send(result)
        })

        app.post("/riders", async (req, res) => {
            const rider = req.body;
            rider.status = 'pending'
            rider.appliedAt = new Date()
            const result = await ridersCollection.insertOne(rider)
            res.send(result)
        })

        app.patch("/riders/:id", verifyFirebaseToken, async (req, res) => {
            const status = req.body.status
            const id = req.params.id
            const quary = { _id: new ObjectId(id) }
            const updateDoc = {
                $set: {
                    status: status,
                    workStatus: 'available'
                }
            }
            const result = await ridersCollection.updateOne(quary, updateDoc)

            if (status === 'approved') {
                const email = req.body.email
                const userQuery = { email }
                const updateUser = {
                    $set: {
                        role: 'rider'
                    }
                }
                const updateRole = await usersCollection.updateOne(userQuery, updateUser)

            }
            res.send(result)
        })





        // TRACKINGS API
        app.get("/trackings/:trackingId/logs", async (req, res) => {
            const trackingId = req.params.trackingId;

            const query = { trackingId };

            const result = await trackingsCollection.find(query).toArray()
            res.send(result)
        })


        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        // await client.close();
    }
}
run().catch(console.dir);




app.listen(port, () => {
    console.log(`Swift move server is running on port ${port}`)
})