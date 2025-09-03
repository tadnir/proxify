import { logger } from "./logger"
import axios from "axios";


interface ProxyHostOptions {
  npmUrl: string;
  domainName: string;
  scheme: string;
  forwardHost: string;
  port: number;
  certificateId: number;
  apiKey: string;
}


export async function createProxyHost({
    npmUrl,
    domainName,
    scheme,
    forwardHost,
    port,
    certificateId,
    apiKey
}: ProxyHostOptions) {
  const url = `${npmUrl}/api/nginx/proxy-hosts`;

  const data = {
    domain_names: [`${domainName}`],
    forward_scheme: scheme,
    forward_host: forwardHost,
    forward_port: port,
    certificate_id: certificateId,
    block_exploits: "true",
    caching_enabled: "true",
    http2_support: "true",
    enabled: "true"
  };

  const statusCodeExplanations: Record<number, string> = {
    200: "OK: The request was successful.",
    201: "Created: The request was successful and a resource was created.",
    400: "Bad Request: The request was invalid or cannot be otherwise served - this may mean the proxy host already exists, or some config error.",
    401: "Unauthorized: Authentication is required and has failed or has not yet been provided.",
    403: "Forbidden: The request was valid, but the server is refusing action.",
    404: "Not Found: The requested resource could not be found.",
    405: "Method Not Allowed: A request method is not supported for the requested resource.",
    408: "Request Timeout: The server timed out waiting for the request.",
    500: "Internal Server Error: An error has occurred in the server.",
    502: "Bad Gateway: The server was acting as a gateway or proxy and received an invalid response from the upstream server.",
    503: "Service Unavailable: The server is not ready to handle the request.",
    504: "Gateway Timeout: The server was acting as a gateway or proxy and did not receive a timely response from the upstream server."
  };

  try {
    logger.info(`Sending requrest ${JSON.stringify(data, null, 2)} to ${url}`);
    const response = await axios.post(url, data, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      }
    });

    if (statusCodeExplanations[response.status]) {
      logger.debug(`HTTP ${response.status}: ${statusCodeExplanations[response.status]}`);
      if ([200, 201].includes(response.status)) {
        logger.info(`Proxy host for ${domainName} created successfully`);
      } else {
        logger.error(
          `Error creating proxy host for ${domainName}. Returned status code: ${response.status}.`
        );
      }
    } else {
      logger.error(`Received unexpected status code: ${response.status}`);
    }
  } catch (error: unknown) {
    if (axios.isAxiosError(error) && error.response) {
      console.error(
        `Axios - HTTP ${error.response.status}: ${statusCodeExplanations[error.response.status] || "Unknown error"}`
      );
    } else if (error instanceof Error) {
      console.error("Error:", error.message);
    } else {
      console.error("Unexpected error", error);
    }
  }
}
