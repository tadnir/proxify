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
      DOMAIN_NAME: example.com # apps will be available at <app-name>.example.com
      NPM_APP_NAME: nginxproxy # change to the app name in TrueNas
      NPM_APP_PORT: 81 # port for npm web ui
      NPM_MAIL: admin@example.com # NPM admin email/username
      NPM_PASSWORD: yourpassword # NPM admin password
      # OR use NPM_TOKEN: your-jwt-token # NPM JWT token (alternative to credentials)
      NPM_TOKEN_REFRESH_INTERVAL: 60 # Token refresh interval in minutes (0 to disable)
      NPM_CERT_ID: 1 # The Id of the certificate to set of the proxies (id can be seen in web ui)
      APP_BLACKLIST: "nginxproxy,dragonify,proxify" # List of apps that won't be configured to npm
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
```

Once started, all of your apps will now proxied with NPM.

## Authentication

Proxify supports two authentication methods for NPM:

### Method 1: Credentials (Recommended for Production)
Use your NPM admin email and password:
```yaml
NPM_MAIL: admin@example.com
NPM_PASSWORD: yourpassword
```

**Benefits:**
- ✅ Fully automatic token management
- ✅ No manual intervention required
- ✅ Works seamlessly across container restarts
- ✅ Recommended for production deployments

### Method 2: JWT Token (For Testing/Development/One-time Setup)
Use a pre-generated JWT token:
```yaml
NPM_TOKEN: eyJhbGciOiJSUzUxMiIsInR5cCI6IkpXVCJ9...
```

#### Getting a Token via API
If you need to generate a token manually, you can use this curl command:
```bash
curl -X POST "http://your-npm-server:81/api/tokens" \
  -H "Content-Type: application/json" \
  -d '{
    "identity": "admin@example.com",
    "secret": "yourpassword"
  }'
```

The response will contain a `token` field with your JWT token.

**Use Cases:**
- ✅ One-time proxy configuration setup
- ✅ Testing and development environments
- ✅ Short-term deployments

**Limitations:**
- ⚠️ Manual token updates required after container restarts
- ⚠️ Not suitable for long-term production without external token management
- ⚠️ Tokens expire after 24 hours

**Note:** You must provide either credentials (`NPM_MAIL` + `NPM_PASSWORD`) or a token (`NPM_TOKEN`), credentials are preffered if both supplied.

## Token Refresh

Proxify automatically refreshes NPM tokens to ensure continuous operation:

- **`NPM_TOKEN_REFRESH_INTERVAL`** - Sets the refresh interval in minutes (default: 60)
- **Set to 0** to disable automatic token refresh
- **Recommended value**: 60 minutes (tokens typically expire after 24 hours)
- **Graceful shutdown** - Refresh interval is properly cleaned up on application exit

### Important Notes:

#### For Credentials Authentication (`NPM_MAIL` + `NPM_PASSWORD`):
- ✅ **Fully automatic** - No manual intervention required
- ✅ **Persistent across restarts** - Always creates fresh tokens on startup
- ✅ **Recommended for production** use

#### For Token Authentication (`NPM_TOKEN`):
- ⚠️ **Manual token updates required** - When container restarts, you must update `NPM_TOKEN` with a fresh token
- ⚠️ **No token persistence** - Refreshed tokens are not saved between container restarts
- ✅ **Suitable for one-time setup** - Perfect for initial proxy configuration
- ✅ **Good for testing/development** - When you can manually update tokens

### Examples:
```yaml
# Refresh every 30 minutes
NPM_TOKEN_REFRESH_INTERVAL: 30

# Refresh every 2 hours
NPM_TOKEN_REFRESH_INTERVAL: 120

# Disable automatic refresh
NPM_TOKEN_REFRESH_INTERVAL: 0
```

## License

MIT