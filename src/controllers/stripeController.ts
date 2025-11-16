import { Request, Response } from "express"
import { asyncHandler } from "../middleware/asyncHandler"
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb"
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb"
import Stripe from "stripe"
import { AuthenticatedRequest } from "../middleware/auth"

const stripe = new Stripe(process.env.EXPRESS_STRIPE_SECRET_KEY!, {
  apiVersion: "2025-10-29.clover",
})

const client = new DynamoDBClient({ region: process.env.AWS_REGION_CODE })
const USERS_TABLE = process.env.DYNAMODB_USERS_TABLE || "Users"

export const stripeWebhook = asyncHandler(async (req: Request, res: Response) => {
  const sig = req.headers["stripe-signature"]

  if (!sig) {
    return res.status(400).json({ error: "Missing Stripe signature" })
  }

  let event: Stripe.Event

  try {
    event = stripe.webhooks.constructEvent(
      req.body,                       // raw body from express.raw()
      sig,
      process.env.EXPRESS_STRIPE_WEBHOOK_SECRET!
    )
  } catch (err: any) {
    console.error("❌ Stripe signature verification failed:", err.message)
    return res.status(400).send(`Webhook Error: ${err.message}`)
  }

  // ------------------------------------------------------------
  // 🔥 Handle the checkout session payment confirmation
  // ------------------------------------------------------------
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session

    const userId = session.client_reference_id
    const stripeCustomerId = session.customer as string
    const subscriptionId = session.subscription as string

    if (!userId) {
      console.error("❌ Missing client_reference_id on Stripe session.")
      return res.status(400).json({ error: "Missing userId in checkout session" })
    }

    console.log(`✅ Payment completed for user: ${userId}`)
    console.log(`➡ Saving subscriptionId ${subscriptionId} to DynamoDB`)

    await client.send(
      new UpdateItemCommand({
        TableName: USERS_TABLE,
        Key: marshall({ user_id: userId }),
        UpdateExpression:
          "SET membershipId = :membershipId, stripeCustomerId = :customer, membership_status = :status",
        ExpressionAttributeValues: marshall({
          ":membershipId": subscriptionId,
          ":customer": stripeCustomerId,
          ":status": "active",
        }),
      })
    )
  }

  // ------------------------------------------------------------
  // 🔥 Optional: Handle subscription updated (renewals, changes)
  // ------------------------------------------------------------
  if (event.type === "customer.subscription.updated") {
    const subscription = event.data.object as Stripe.Subscription

    const userId = subscription.metadata?.userId // if you add metadata at creation

    if (userId) {
      await client.send(
        new UpdateItemCommand({
          TableName: USERS_TABLE,
          Key: marshall({ user_id: userId }),
          UpdateExpression: "SET membership_status = :status",
          ExpressionAttributeValues: marshall({
            ":status": subscription.status, // active | past_due | canceled
          }),
        })
      )
    }
  }

  res.json({ received: true })
})

/* ------------------------------------------------------------
   GET /billing
   Fetch subscription, invoices, payment method for logged-in user
------------------------------------------------------------ */
export const getBillingInfo = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user?.user_id

  if (!userId) return res.status(400).json({ error: "Missing userId" })

  // Fetch user from DynamoDB
  const userResult = await client.send(
    new GetItemCommand({
      TableName: USERS_TABLE,
      Key: marshall({ user_id: userId }),
    })
  )

  if (!userResult.Item) {
    return res.status(404).json({ error: "User not found" })
  }

  const user = unmarshall(userResult.Item)

  if (!user.stripeCustomerId) {
    return res.json({
      subscription: null,
      invoices: [],
      payment_method: null,
    })
  }

  const customerId = user.stripeCustomerId

  // Fetch subscription
  const subscriptions = await stripe.subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 1,
  })

  const subscription = subscriptions.data[0] || null

  // Fetch invoices
  const invoices = await stripe.invoices.list({
    customer: customerId,
    limit: 10,
  })

  // Fetch default payment method
  let paymentMethod = null
  if (subscription?.default_payment_method) {
    paymentMethod = await stripe.paymentMethods.retrieve(
      subscription.default_payment_method as string
    )
  }

  res.json({
    subscription,
    invoices: invoices.data,
    payment_method: paymentMethod,
  })
})


/* ------------------------------------------------------------
   GET /billing/portal
   Creates a Stripe Billing Portal session
------------------------------------------------------------ */
export const getBillingPortalSession = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user?.user_id

  if (!userId) return res.status(400).json({ error: "Missing userId" })

  // Fetch user from DynamoDB
  const userResult = await client.send(
    new GetItemCommand({
      TableName: USERS_TABLE,
      Key: marshall({ user_id: userId }),
    })
  )

  if (!userResult.Item) {
    return res.status(404).json({ error: "User not found" })
  }

  const user = unmarshall(userResult.Item)

  if (!user.stripeCustomerId) {
    return res.status(400).json({ error: "User has no Stripe customer" })
  }

  // Create Stripe Billing Portal session
  const portal = await stripe.billingPortal.sessions.create({
    customer: user.stripeCustomerId,
    return_url: process.env.FRONTEND_URL + "/billing",
  })

  res.json(portal.url)
})
