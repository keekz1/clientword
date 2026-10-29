// Security headers shared by the local server and next.config.mjs.
// `uploadOrigin` is the S3 address browsers upload to directly (empty when uploads go through the server).
export const csp = (uploadOrigin = "") =>
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'${uploadOrigin ? " " + uploadOrigin : ""}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;

export function securityHeaders({ production, uploadOrigin }) {
  const h = {
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    "content-security-policy": csp(uploadOrigin),
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
  };
  if (production) h["strict-transport-security"] = "max-age=31536000; includeSubDomains";
  return h;
}
