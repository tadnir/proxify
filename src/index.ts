import Docker from "dockerode"
import { getEventStream } from "./docker-events"
import { logger } from "./logger"
import { createProxyHost } from "./nginx-proxy.js";

// Comma-separated list in env, e.g. "adguard,radarr"
const BLACKLIST = (process.env.APP_BLACKLIST || "")
  .split(",")
  .map(name => name.trim())
  .filter(Boolean);

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

  await createProxyHost({
    npmUrl: `http://npm.ix-${process.env.NPM_APP_NAME}.svc.cluster.local:${process.env.NPM_APP_PORT}`,
    domainName: `${appName}.${process.env.DOMAIN_NAME || "example.com"}`,
    scheme: "http",
    forwardHost: dnsName,
    port: 80,
    certificateId: Number(process.env.CERT_ID) || 0,
    apiKey: process.env.NPM_API_KEY || ""
  });

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
}

main()
