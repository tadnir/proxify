import Docker from "dockerode"
import { getEventStream, getDnsName, getAppName, isIxAppContainer, prohibitedNetworkMode, listApps, hasOpenPort, getOpenPorts } from "./docker"
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

async function selectAppContainer(docker: Docker, appName: string) {
    // Get all containers for this app
    let appContainers = await docker.listContainers({
      limit: -1,
      filters: {
        label: [ "com.docker.compose.project" ]
      }
    })
    appContainers = appContainers.filter(container => {
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
  
    // Filter containers with open ports
    const containersWithPorts = appContainers.filter(container => {
      const openPorts = getOpenPorts(container);
      return openPorts.length > 0;
    });
  
    if (containersWithPorts.length === 0) {
      logger.debug(`No containers with open ports found for app ${appName}`);
      return;
    }
  
    // Select container based on port priority: 443 (HTTPS) > 80 (HTTP) > first available
    let selectedContainer: Docker.ContainerInfo;
    let scheme: string;
    let port: number;
  
    const httpsContainer = containersWithPorts.find(container => hasOpenPort(container, 443));
    const httpContainer = containersWithPorts.find(container => hasOpenPort(container, 80));
  
    if (httpsContainer) {
      selectedContainer = httpsContainer;
      scheme = "https";
      port = 443;
      logger.debug(`App ${appName}: Using HTTPS container ${selectedContainer.Id} with port 443`);
    } else if (httpContainer) {
      selectedContainer = httpContainer;
      scheme = "http";
      port = 80;
      logger.debug(`App ${appName}: Using HTTP container ${selectedContainer.Id} with port 80`);
    } else {
      selectedContainer = containersWithPorts[0];
      scheme = "http";
      port = getOpenPorts(selectedContainer)[0];
      logger.debug(`App ${appName}: Using first available container ${selectedContainer.Id} with port ${port}`);
    }

    logger.debug(`App ${appName} has ${containersWithPorts.length} containers with open ports, choosing: ${selectedContainer.Id}`);
    return {
      container: selectedContainer,
      port: port,
      scheme: scheme
    }
}

async function proxyApp(docker: Docker, appName: string) {
  try {
    let container: Docker.ContainerInfo;
    let port: number;
    let scheme: string;
    const appOverride = process.env[`APP_OVERRIDE_${appName.toUpperCase()}`];
    if (appOverride) {
      logger.info(`Found override for app ${appName}: ${appOverride}`);
      const [containerName, portStr] = appOverride.split(':');
      port = parseInt(portStr, 10);
      if (!containerName || isNaN(port)) {
        throw new Error(`Invalid override format for ${appName}, expected '<container-name>:<port>'`);
      }

      // Get all containers for this app
      let appContainers = await docker.listContainers({
        limit: -1,
        filters: {
          label: [ "com.docker.compose.project" ]
        }
      })
      let matches = appContainers.filter(container => {
        if (!isIxAppContainer(container)) return false;
        if (getAppName(container) !== appName) return false;
        if (prohibitedNetworkMode(container)) {
          logger.debug(`Container ${container.Id} is using network mode ${container.HostConfig.NetworkMode}, skipping`);
          return false;
        }
        return container.Names.some(n => n.replace(/^\//, "").replace(/-\d+$/, "") === `ix-${appName}-${containerName}`);
      });
      if (matches.length != 1) {
        throw new Error(`Found invalid amount of containers (${matches.length}) matching override '${containerName}' of app '${appName}'`);
      }

      container = matches[0];
      scheme = port === 443 ? "https" : "http";
      logger.debug(`App ${appName}: Using OVERRIDE container ${container.Id} with port ${port} (${scheme})`);
    } else {
      const selectedInfo = await selectAppContainer(docker, appName);
      if (!selectedInfo) {
        // Cloudn't select app container, logs from inside the function.
        return;
      }

      container = selectedInfo.container;
      port = selectedInfo.port;
      scheme = selectedInfo.scheme;
    }

    const dnsName = getDnsName(container);
    await npmServer.createProxyHost({
      domainName: `${appName}.${process.env.DOMAIN_NAME || "example.com"}`,
      scheme: scheme,
      forwardHost: dnsName,
      port: port,
      certificateId: Number(process.env.NPM_CERT_ID) || 0
    });

    logger.info(`Application ${appName} proxied via container ${container.Id} (${container.Names.join(", ")}) -> ${dnsName}`);
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
