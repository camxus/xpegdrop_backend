import { PostHog } from "posthog-node"
import dotenv from "dotenv"

dotenv.config()

type Properties = Record<string, any>

class PostHogClient {
  private client: PostHog

  constructor() {
    const apiKey = process.env.EXPRESS_POSTHOG_API_KEY
    const host = process.env.EXPRESS_POSTHOG_HOST || "https://eu.i.posthog.com"

    if (!apiKey) {
      throw new Error("Missing POSTHOG_API_KEY environment variable")
    }

    this.client = new PostHog(apiKey, { host })
  }

  /**
   * Identify a user
   */
  identify(distinctId: string, properties?: Properties) {
    try {
      this.client.identify({
        distinctId,
        properties
      })
    } catch (error) {
      console.error("PostHog identify error:", error)
    }
  }

  /**
   * Track an event
   */
  track(event: string, distinctId: string, properties?: Properties) {
    try {
      this.client.capture({
        event,
        distinctId,
        properties
      })
    } catch (error) {
      console.error("PostHog track error:", error)
    }
  }

  /**
   * Track signup event (semantic helper)
   */
  trackSignup(
    distinctId: string,
    properties?: Properties
  ) {
    this.track("user_signed_up", distinctId, properties)
  }

  /**
   * Flush & shutdown (important for serverless)
   */
  async shutdown() {
    await this.client.shutdown()
  }
}

/**
 * Singleton export
 */
export const posthog = new PostHogClient()
