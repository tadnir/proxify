import Docker from "dockerode"
import EventEmitter from "events"

import { chain } from "stream-chain"
import { parser } from "stream-json/jsonl/Parser"

export function getEventStream(docker: Docker): EventEmitter {
  const emitter = new EventEmitter()

  docker.getEvents((err, rawStream) => {
    const stream = chain<any[]>([
      rawStream,
      parser()
    ])

    stream.on("data", (data) => {
      const event = data.value
      emitter.emit(`${event.Type}.${event.Action}`, data.value)
    })
  })

  return emitter
}

export function getDnsName(container: Docker.ContainerInfo) {
  const service = container.Labels["com.docker.compose.service"]
  const project = container.Labels["com.docker.compose.project"]
  return `${service}.${project}.svc.cluster.local`
}

export function getAppName(container: Docker.ContainerInfo) {
  const label = container.Labels["com.docker.compose.project"]; // e.g. "ix-radarr"
  const name = label.replace(/^ix-/, ""); // → "radarr"
  return name;
}

export function isIxAppContainer(container: Docker.ContainerInfo) {
  return container.Labels["com.docker.compose.project"].startsWith("ix-")
}

export function prohibitedNetworkMode(container: Docker.ContainerInfo) {
  return [ "none", "host" ].includes(container.HostConfig.NetworkMode) ||
      container.HostConfig.NetworkMode.startsWith("container:") ||
      container.HostConfig.NetworkMode.startsWith("service:")
}

export function hasOpenPort(container: Docker.ContainerInfo, port: number): boolean {
  if (!container.Ports) return false;
  return container.Ports.some(portInfo => portInfo.PrivatePort === port);
}

export function getOpenPorts(container: Docker.ContainerInfo): number[] {
  if (!container.Ports) return [];
  return container.Ports.map(portInfo => portInfo.PrivatePort);
}

export async function listApps(docker: Docker): Promise<string[]> {
  const allContainers = await docker.listContainers({
    limit: -1,
    filters: {
      label: [ "com.docker.compose.project" ]
    }
  });

  const appNames = new Set<string>();
  for (const container of allContainers) {
    if (isIxAppContainer(container)) {
      appNames.add(getAppName(container));
    }
  }

  return Array.from(appNames);
}