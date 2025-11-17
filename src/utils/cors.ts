export function createCorsConfig() {
  const allowedOrigins: (string | RegExp)[] = ["http://localhost:3000"];

  const envOrigin = process.env.EXPRESS_PUBLIC_FRONTEND_URL;

  if (envOrigin) {
    // Case 1: Wildcard, like "*.fframess.com"
    if (envOrigin.startsWith("*.")) {
      // remove "*."
      const domain = envOrigin.slice(2);

      // escape dots
      const escaped = domain.replace(/\./g, "\\.");

      // allow:
      // https://fframess.com
      // https://app.fframess.com
      // https://sub.app.fframess.com
      const regex = new RegExp(
        `^https?:\\/\\/([a-zA-Z0-9-]+\\.)*${escaped}$`
      );

      allowedOrigins.push(regex);
    }

    // Case 2: Normal exact URL, like "https://studio.fframess.com"
    else {
      allowedOrigins.push(envOrigin);
    }
  }

  return {
    origin: allowedOrigins,
    credentials: true,
  };
}
