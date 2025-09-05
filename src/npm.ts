import { logger } from "./logger"
import axios from "axios";

// Custom exception classes
export class NPMAuthenticationError extends Error {
  constructor(message: string, public statusCode?: number) {
    super(message);
    this.name = 'NPMAuthenticationError';
  }
}

export class NPMTokenError extends Error {
  constructor(message: string, public statusCode?: number) {
    super(message);
    this.name = 'NPMTokenError';
  }
}

export class NPMProxyHostError extends Error {
  constructor(message: string, public statusCode?: number) {
    super(message);
    this.name = 'NPMProxyHostError';
  }
}

export class NPMNetworkError extends Error {
  constructor(message: string, public originalError?: unknown) {
    super(message);
    this.name = 'NPMNetworkError';
  }
}

interface ProxyHostOptions {
  domainName: string;
  scheme: string;
  forwardHost: string;
  port: number;
  certificateId: number;
}

interface TokenResponse {
  expires: string;
  token: string;
}

interface TokenData {
  token: string;
  expires: Date;
}

interface NPMServerCredentials {
  identity: string;
  secret: string;
}

interface NPMServerToken {
  token: string;
}


export class NPMServer {
  private npmUrl: string;
  private tokenData: TokenData | null = null;
  private credentials: NPMServerCredentials | null = null;

  constructor(npmUrl: string, auth: NPMServerCredentials | NPMServerToken) {
    this.npmUrl = npmUrl;
    
    if ('identity' in auth && 'secret' in auth) {
      this.credentials = auth;
    } else if ('token' in auth) {
      // For existing token, set it temporarily - refresh will update with expiration
      this.tokenData = { token: auth.token, expires: new Date(0) };
    }
  }

  // Static factory method for async initialization
  static async create(npmUrl: string, auth: NPMServerCredentials | NPMServerToken): Promise<NPMServer> {
    const server = new NPMServer(npmUrl, auth);
    await server.refreshToken();
    return server;
  }

  private async createToken(): Promise<TokenResponse> {
    if (!this.credentials) {
      throw new NPMTokenError("No credentials available to create token");
    }
    
    const url = `${this.npmUrl}/api/tokens`;
    const data = {
      identity: this.credentials.identity,
      secret: this.credentials.secret
    };

    try {
      logger.info(`Sending token request for identity: ${this.credentials.identity} to ${url}`);
      const response = await axios.post<TokenResponse>(url, data, {
        headers: {
          "Content-Type": "application/json"
        }
      });

      if ([200, 201].includes(response.status)) {
        logger.info(`Token created successfully for identity: ${this.credentials.identity}`);
        return response.data;
      } else {
        const errorMessage = `Failed to create token for identity: ${this.credentials.identity}. Status: ${response.status}`;
        logger.error(errorMessage);
        throw new NPMTokenError(errorMessage, response.status);
      }
    } catch (error: unknown) {
      if (axios.isAxiosError(error)) {
        if (error.response) {
          const errorMessage = `Token creation failed with status ${error.response.status}`;
          logger.error(errorMessage);
          throw new NPMTokenError(errorMessage, error.response.status);
        } else if (error.request) {
          const errorMessage = "Network error during token creation - no response received";
          logger.error(errorMessage);
          throw new NPMNetworkError(errorMessage, error);
        }
      }
      
      const errorMessage = error instanceof Error ? error.message : "Unknown error during token creation";
      logger.error(errorMessage);
      throw new NPMTokenError(errorMessage);
    }
  }

  private isTokenValid(): boolean {
    if (!this.tokenData) return false;
    const now = new Date();
    const bufferTime = 5 * 60 * 1000; // 5 minutes buffer
    return this.tokenData.expires.getTime() > (now.getTime() + bufferTime);
  }

  private async ensureValidToken(): Promise<void> {
    if (!this.isTokenValid()) {
      logger.info("Token is expired or will expire soon, refreshing...");
      await this.refreshToken();
    }
  }

  public async refreshToken(): Promise<TokenResponse> {
    // First try to refresh existing token if available
    if (this.tokenData?.token) {
      try {
        return await this.refreshExistingToken();
      } catch (error) {
        logger.warn("Token refresh failed, will try to create new token with credentials");
        // Continue to fallback below
      }
    }

    // If no token or refresh failed, try to create new token with credentials
    if (this.credentials) {
      const tokenResponse = await this.createToken();
      this.tokenData = {
        token: tokenResponse.token,
        expires: new Date(tokenResponse.expires)
      };
      return tokenResponse;
    }

    throw new NPMTokenError("No token available and no credentials to create new token");
  }

  private async refreshExistingToken(): Promise<TokenResponse> {
    if (!this.tokenData?.token) {
      throw new NPMTokenError("No existing token to refresh");
    }

    const url = `${this.npmUrl}/api/tokens`;

    try {
      logger.info(`Refreshing existing token at ${url}`);
      const response = await axios.get<TokenResponse>(url, {
        headers: {
          Authorization: `Bearer ${this.tokenData.token}`,
          "Content-Type": "application/json"
        }
      });

      if ([200, 201].includes(response.status)) {
        logger.info(`Token refreshed successfully`);
        this.tokenData = {
          token: response.data.token,
          expires: new Date(response.data.expires)
        };
        return response.data;
      } else {
        const errorMessage = `Token refresh failed with status ${response.status}`;
        logger.error(errorMessage);
        throw new NPMTokenError(errorMessage, response.status);
      }
    } catch (error: unknown) {
      if (axios.isAxiosError(error)) {
        if (error.response) {
          const errorMessage = `Token refresh failed with status ${error.response.status}`;
          logger.error(errorMessage);
          throw new NPMTokenError(errorMessage, error.response.status);
        } else if (error.request) {
          const errorMessage = "Network error during token refresh - no response received";
          logger.error(errorMessage);
          throw new NPMNetworkError(errorMessage, error);
        }
      }
      
      const errorMessage = error instanceof Error ? error.message : "Unknown error during token refresh";
      logger.error(errorMessage);
      throw new NPMTokenError(errorMessage);
    }
  }

  public async createProxyHost(options: ProxyHostOptions): Promise<void> {
    // Ensure we have a valid token before making the request
    await this.ensureValidToken();

    const url = `${this.npmUrl}/api/nginx/proxy-hosts`;
    const data = {
      domain_names: [`${options.domainName}`],
      forward_scheme: options.scheme,
      forward_host: options.forwardHost,
      forward_port: options.port,
      certificate_id: options.certificateId,
      block_exploits: "true",
      caching_enabled: "true",
      http2_support: "true",
      enabled: "true"
    };

    try {
      logger.info(`Sending request ${JSON.stringify(data, null, 2)} to ${url}`);
      const response = await axios.post(url, data, {
        headers: {
          Authorization: `Bearer ${this.tokenData!.token}`,
          "Content-Type": "application/json"
        }
      });

      if ([200, 201].includes(response.status)) {
        logger.info(`Proxy host for ${options.domainName} created successfully`);
        return;
      } else if (response.status === 400) {
        // 400 might mean the proxy host already exists
        logger.warn(`Proxy host for ${options.domainName} may already exist (status 400)`);
        return;
      } else {
        const errorMessage = `Failed to create proxy host for ${options.domainName}. Status: ${response.status}`;
        logger.error(errorMessage);
        throw new NPMProxyHostError(errorMessage, response.status);
      }
    } catch (error: unknown) {
      if (axios.isAxiosError(error)) {
        if (error.response) {
          if (error.response.status === 400) {
            // 400 might mean the proxy host already exists
            logger.warn(`Proxy host for ${options.domainName} may already exist (status 400)`);
            return;
          } else {
            const errorMessage = `Proxy host creation failed with status ${error.response.status}`;
            logger.error(errorMessage);
            throw new NPMProxyHostError(errorMessage, error.response.status);
          }
        } else if (error.request) {
          const errorMessage = "Network error during proxy host creation - no response received";
          logger.error(errorMessage);
          throw new NPMNetworkError(errorMessage, error);
        }
      }
      
      const errorMessage = error instanceof Error ? error.message : "Unknown error during proxy host creation";
      logger.error(errorMessage);
      throw new NPMProxyHostError(errorMessage);
    }
  }
}
