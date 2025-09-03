# Proxify

This utility is based on (and recommended to use with) the [dragonify solution from tjhorner](https://github.com/tjhorner/dragonify).

Proxify is meant to be used with TrueNAS SCALE to configure NPM (Nginx Proxy Manager) automatically to have a proxy for each app.
It assumes each app is available at `{service}.ix-{app-name}.svc.cluster.local` and proxy them at `<app-name>.<proxy-domain>`.

## Installation

1. Go to "Apps" in the TrueNAS SCALE web UI.
2. Click "Discover Apps".
3. Click **⋮** in the top-right corner, then "Install via YAML".
4. Set the name to `proxify`, and paste the following YAML into the text box.

```yaml
services:
  proxify:
    image: ghcr.io/tadnir/proxify:main
    restart: always
    environment:
      LOG_LEVEL: info # change to debug for more verbose logging
      NPM_APP_NAME: nginxproxy # change to the app name in TrueNas
      DOMAIN_NAME: example.com # apps will be available at <app-name>.example.com
      NPM_API_KEY: npmapikey # put npm admin key
      NPM_APP_PORT: 81 # port for npm web ui
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
```

Once started, all of your apps will now proxied with NPM.

## License

MIT