// Copy-and-paste examples for sending a WhatsApp message through Gakai's API.
// Plain strings (no JSX) so they are unit-testable and exactly what gets copied.
export const SEND_PATH = "/api/integrations/v1/messages";
export const TOKEN_PLACEHOLDER = "YOUR_TOKEN";
export const ACCOUNT_PLACEHOLDER = "YOUR_ACCOUNT_ID";

// `accountId` is the WhatsApp account the token belongs to. The token alone decides who sends; naming the
// account in the body is a safety check that fails loudly if the wrong token is used.
const bodyFor = accountId => ({ accountId: accountId || ACCOUNT_PLACEHOLDER, phone: "15551234567", text: "Hello from Gakai" });

// The request body on its own — for any HTTP client.
export const jsonSample = accountId => JSON.stringify(bodyFor(accountId), null, 2);

// A complete command: this server's address, the Authorization header, the body.
export function curlSample(origin, token = TOKEN_PLACEHOLDER, accountId) {
  return [
    `curl -X POST ${origin}${SEND_PATH} \\`,
    `  -H "Authorization: Bearer ${token}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '${JSON.stringify(bodyFor(accountId))}'`,
  ].join("\n");
}
