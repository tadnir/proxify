import Docker from "dockerode"
import { getEventStream, getDnsName, getAppName, isIxAppContainer, prohibitedNetworkMode, listApps } from "./docker"
import { logger } from "./logger"
import { NPMServer } from "./npm";

// Comma-separated list in env, e.g. "adguard,radarr"
const BLACKLIST = (process.env.APP_BLACKLIST || "")
  .split(",")
  .map(name => name.trim())
  .filter(Boolean);

// Initialize NPM Server
let npmServer: NPMServer;
let refreshInterval: NodeJS.Timeout | null = null;

async function initializeNPMServer(): Promise<void> {
  const npmUrl = `http://npm.ix-${process.env.NPM_APP_NAME}.svc.cluster.local:${process.env.NPM_APP_PORT}`;
  
  // Check if we have credentials or token
  if (process.env.NPM_MAIL && process.env.NPM_PASSWORD) {
    // Use credentials constructor
    logger.info("Initializing NPM server with credentials");
    npmServer = await NPMServer.create(npmUrl, {
      identity: process.env.NPM_MAIL,
      secret: process.env.NPM_PASSWORD
    });
  } else if (process.env.NPM_TOKEN) {
    // Use token constructor
    logger.info("Initializing NPM server with existing token");
    npmServer = await NPMServer.create(npmUrl, {
      token: process.env.NPM_TOKEN
    });
  } else {
    throw new Error("Either NPM_MAIL/NPM_PASSWORD or NPM_TOKEN must be provided");
  }
  
  logger.info("NPM server initialized successfully");
}

function startTokenRefresh(): void {
  const refreshIntervalMinutes = parseInt(process.env.NPM_TOKEN_REFRESH_INTERVAL || "60");
  
  if (refreshIntervalMinutes <= 0) {
    logger.info("Token refresh disabled (NPM_TOKEN_REFRESH_INTERVAL <= 0)");
    return;
  }
  
  const refreshIntervalMs = refreshIntervalMinutes * 60 * 1000; // Convert minutes to milliseconds
  
  logger.info(`Starting token refresh every ${refreshIntervalMinutes} minutes`);
  
  refreshInterval = setInterval(async () => {
    try {
      logger.info("Refreshing NPM token...");
      await npmServer.refreshToken();
      logger.info("NPM token refreshed successfully");
    } catch (error) {
      logger.error("Failed to refresh NPM token:", error);
    }
  }, refreshIntervalMs);
}

function stopTokenRefresh(): void {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
    logger.info("Token refresh stopped");
  }
}

async function proxyApp(docker: Docker, appName: string) {
  // Get all containers for this app
  const appContainers = await docker.listContainers({
    limit: -1,
    filters: {
      label: [ "com.docker.compose.project" ]
    }
  }).filter(container => {
    if (!isIxAppContainer(container)) return false;
    if (getAppName(container) !== appName) return false;
    if (prohibitedNetworkMode(container)) {
      logger.debug(`Container ${container.Id} is using network mode ${container.HostConfig.NetworkMode}, skipping`);
      return false;
    }
    return true;
  });

  if (appContainers.length === 0) {
    logger.debug(`No valid containers found for app ${appName}`);
    return;
  }

  // Pick the first valid container
  const selectedContainer = appContainers[0];
  const dnsName = getDnsName(selectedContainer);
  logger.debug(`App ${appName} has ${appContainers.length} valid containers, proxfing: ${selectedContainer.Id}`);

  try {
    await npmServer.createProxyHost({
      domainName: `${appName}.${process.env.DOMAIN_NAME || "example.com"}`,
      scheme: "http",
      forwardHost: dnsName,
      port: 80,
      certificateId: Number(process.env.NPM_CERT_ID) || 0
    });

    logger.info(`Application ${appName} proxied via container ${selectedContainer.Id} (${selectedContainer.Names.join(", ")}) -> ${dnsName}`);
  } catch (error) {
    logger.error(`Failed to create proxy host for ${appName}:`, error);
    return;
  }
}

async function main() {
  try {
    // Initialize
    await initializeNPMServer();
    const docker = new Docker()
    startTokenRefresh();

    // Proxy existing applications
    logger.debug("Proxying existing applications")
    for (const appName of await listApps(docker)) {
      if (BLACKLIST.includes(appName)) {
        logger.debug(`Application ${appName} is blacklisted, skipping`);
        continue;
      }

      logger.info(`Proxying application ${appName}`);
      await proxyApp(docker, appName);
    }
    
    // Proxy new applications
    getEventStream(docker).on("container.start", async (event) => {
      const [ container ] = await docker.listContainers({
        filters: {
          id: [ event.Actor["ID"] ]
        }
      })

      if (!container) {
        logger.warn(`Container ${event.Actor["ID"]} not found`)
        return
      }

      if (!isIxAppContainer(container)) {
        logger.debug(`Container ${container.Id} is not from ix app, skipping`)
        return
      }

      const appName = getAppName(container);
      logger.debug(`New container started for app ${appName}: ${container.Id}`)
      
      if (BLACKLIST.includes(appName)) {
        logger.debug(`Application ${appName} is blacklisted, skipping`);
        return;
      }
      
      // Wait a bit for all containers of the app to start
      logger.debug(`Waiting 5 seconds for all containers of app ${appName} to start`);
      await new Promise(resolve => setTimeout(resolve, 5000));

      logger.info(`Proxying application ${appName}`);
      await proxyApp(docker, appName)
    })
    
    // Graceful shutdown handling
    process.on('SIGINT', () => {
      logger.info('Received SIGINT, shutting down gracefully...');
      stopTokenRefresh();
      process.exit(0);
    });
    
    process.on('SIGTERM', () => {
      logger.info('Received SIGTERM, shutting down gracefully...');
      stopTokenRefresh();
      process.exit(0);
    });
  } catch (error) {
    logger.error("Failed to initialize application:", error);
    process.exit(1);
  }
}

main()
