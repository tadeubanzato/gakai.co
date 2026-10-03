// Copy-and-paste examples for sending a WhatsApp message through Gakai's API.
// Plain strings (no JSX) so they are unit-testable and exactly what gets copied.
export const SEND_PATH = "/api/integrations/v1/messages";
export const TOKEN_PLACEHOLDER = "YOUR_TOKEN";

const body = { phone: "15551234567", text: "Hello from Gakai" };

// The request body on its own — for n8n's HTTP Request node or any HTTP client.
export const jsonSample = () => JSON.stringify(body, null, 2);

// A complete command: this server's address, the Authorization header, the body.
export function curlSample(origin, token = TOKEN_PLACEHOLDER) {
  return [
    `curl -X POST ${origin}${SEND_PATH} \\`,
    `  -H "Authorization: Bearer ${token}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '${JSON.stringify(body)}'`,
  ].join("\n");
}
