import Docker from "dockerode"
import { getEventStream } from "./docker-events"
import { logger } from "./logger"
import { NPMServer } from "./nginx-proxy";

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

function getDnsName(container: Docker.ContainerInfo) {
  const service = container.Labels["com.docker.compose.service"]
  const project = container.Labels["com.docker.compose.project"]
  return `${service}.${project}.svc.cluster.local`
}

function getAppName(container: Docker.ContainerInfo) {
  const label = container.Labels["com.docker.compose.project"]; // e.g. "ix-radarr"
  const name = label.replace(/^ix-/, ""); // → "radarr"
  return name;
}

function isIxAppContainer(container: Docker.ContainerInfo) {
  return container.Labels["com.docker.compose.project"].startsWith("ix-")
}

function prohibitedNetworkMode(networkMode: string) {
  return [ "none", "host" ].includes(networkMode) ||
    networkMode.startsWith("container:") ||
    networkMode.startsWith("service:")
}

async function connectContainerToAppsNetwork(docker: Docker, container: Docker.ContainerInfo) {
  if (!isIxAppContainer(container)) {
    logger.debug(`Container ${container.Id} is not from ix app, skipping`);
  }

  if (prohibitedNetworkMode(container.HostConfig.NetworkMode)) {
    logger.debug(`Container ${container.Id} is using network mode ${container.HostConfig.NetworkMode}, skipping`);
    return
  }

  const dnsName = getDnsName(container);
  const appName = getAppName(container);
  if (BLACKLIST.includes(appName)) {
    logger.debug(`Application ${BLACKLIST} is blacklisted, skipping`);
    return;
  }

  try {
    await npmServer.createProxyHost({
      domainName: `${appName}.${process.env.DOMAIN_NAME || "example.com"}`,
      scheme: "http",
      forwardHost: dnsName,
      port: 80,
      certificateId: Number(process.env.NPM_CERT_ID) || 0
    });
  } catch (error) {
    logger.error(`Failed to create proxy host for ${appName}:`, error);
    return;
  }

  logger.info(`Container ${container.Id} (aka ${container.Names.join(", ")}) proxy ${dnsName}`)
}

function isIxProjectName(name: string) {
  return name.startsWith("ix-")
}

async function connectAllContainersToAppsNetwork(docker: Docker) {
  logger.debug("Connecting existing app containers to network")
  const containers = await docker.listContainers({
    limit: -1,
    filters: {
      label: [ "com.docker.compose.project" ]
    }
  })

  // const appContainers = containers.filter(isIxAppContainer)
  for (const container of containers) {
    // if (isContainerInNetwork(container)) {
    //   logger.debug(`Container ${container.Id} already connected to network`)
    //   continue
    // }

    await connectContainerToAppsNetwork(docker, container)
  }

  logger.info("All existing app containers connected to network")
}

async function connectNewContainerToAppsNetwork(docker: Docker, containerId: string) {
  const [ container ] = await docker.listContainers({
    filters: {
      id: [ containerId ]
    }
  })

  if (!container) {
    logger.warn(`Container ${containerId} not found`)
    return
  }

  logger.debug(`New container started: ${container.Id}`)
  await connectContainerToAppsNetwork(docker, container)
}

async function main() {
  try {
    // Initialize NPM server first
    await initializeNPMServer();
    
    // Start periodic token refresh
    startTokenRefresh();
    
    const docker = new Docker()

    await connectAllContainersToAppsNetwork(docker)

    const events = getEventStream(docker)
    events.on("container.start", (event) => {
      // const containerAttributes = event.Actor.Attributes
      // if (!isIxProjectName(containerAttributes["com.docker.compose.project"])) {
        // return
      // }

      connectNewContainerToAppsNetwork(docker, event.Actor["ID"])
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
