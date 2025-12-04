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
      req.body,
      sig,
      process.env.EXPRESS_STRIPE_WEBHOOK_SECRET!
    )
  } catch (err: any) {
    console.error("❌ Stripe signature verification failed:", err.message)
    return res.status(400).send(`Webhook Error: ${err.message}`)
  }

  // ------------------------------------------------------------
  // checkout.session.completed
  // ------------------------------------------------------------
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session

    const userId = session.client_reference_id
    const stripeCustomerId = session.customer as string
    const subscriptionId = session.subscription as string

    const subscription = await stripe.subscriptions.retrieve(subscriptionId)
    const trialEnd = subscription.trial_end ?? null

    const now = Math.floor(Date.now() / 1000) // current Unix timestamp in seconds
    const status = trialEnd && trialEnd > now ? "trialing" : "active"


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
          "SET stripe.customer_id = :customer, membership.membership_id = :sub, membership.status = :status",
        ExpressionAttributeValues: marshall({
          ":customer": stripeCustomerId,
          ":sub": subscriptionId,
          ":status": status,
        }),
      })
    )
  }

  // ------------------------------------------------------------
  // customer.subscription.updated
  // ------------------------------------------------------------
  if (event.type === "customer.subscription.updated") {
    const subscription = event.data.object as Stripe.Subscription

    const userId = subscription.metadata?.userId

    if (userId) {
      await client.send(
        new UpdateItemCommand({
          TableName: USERS_TABLE,
          Key: marshall({ user_id: userId }),
          UpdateExpression: "SET membership.status = :status",
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
------------------------------------------------------------ */
export const getBillingInfo = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user?.user_id

  if (!userId) return res.status(400).json({ error: "Missing userId" })

  // Fetch user
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

  // No billing info yet
  if (!user.stripe?.customer_id) {
    return res.json({
      subscription: null,
      invoices: [],
      payment_method: null,
    })
  }

  const customerId = user.stripe.customer_id

  // Subscription
  const subscriptions = await stripe.subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 1,
  })

  const subscription = subscriptions.data[0] || null

  // Invoices
  const invoices = await stripe.invoices.list({
    customer: customerId,
    limit: 10,
  })

  // Payment method
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
------------------------------------------------------------ */
export const getBillingPortalSession = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user?.user_id

  if (!userId) return res.status(400).json({ error: "Missing userId" })

  // Fetch user
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

  if (!user.stripe?.customer_id) {
    return res.status(400).json({ error: "User has no Stripe customer" })
  }

  // Create portal session
  const portal = await stripe.billingPortal.sessions.create({
    customer: user.stripe.customer_id,
    return_url: process.env.FRONTEND_URL + "/billing",
  })

  res.json(portal.url)
})
