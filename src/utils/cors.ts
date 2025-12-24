export function createCorsConfig() {
  const allowedOrigins: (string | RegExp)[] = [
    "http://localhost:3000",
  ];

  const envOrigin = process.env.EXPRESS_PUBLIC_FRONTEND_URL;
  const allowSubdomains = Boolean(process.env.EXPRESS_CORS_ALLOW_SUBDOMAINS) || true;

  if (envOrigin) {
    const url = new URL(envOrigin);

    if (allowSubdomains) {
      /**
       * Extract base domain:
       * app.example.com → example.com
       */
      const parts = url.hostname.split(".");
      const baseDomain =
        parts.length > 2 ? parts.slice(-2).join(".") : url.hostname;

      const escaped = baseDomain.replace(/\./g, "\\.");

      const regex = new RegExp(
        `^${url.protocol}//([a-zA-Z0-9-]+\\.)*${escaped}(?::${url.port || "\\d+"})?$`
      );

      allowedOrigins.push(regex);
    } else {
      allowedOrigins.push(envOrigin);
    }
  }

  return {
    origin: allowedOrigins,
    credentials: true,
  };
}
