# Putting CasaTube behind something

CasaTube has **no login of its own**, on purpose: it is built for one household
on a private network, and a password screen written into a downloader is a
weaker lock than the tools below, which do nothing else. This page is how to put
one of those in front of it.

🔴 **Why it matters more than for most self-hosted apps.** Anyone who can reach
the port can use every feature, and one of them is the plugin editor — which
**runs code on the server, by design**. An exposed CasaTube is a remote shell
with a nice UI. Never forward port 8520 on your router.

Pick one:

| | Who can reach it | Effort | Good for |
|---|---|---|---|
| [Private network only](#1-keep-it-on-your-network) | Devices at home | none | One house, one network |
| [Tailscale](#2-tailscale) | Your devices, anywhere | low | Most people — **recommended** |
| [Cloudflare Tunnel + Access](#3-cloudflare-tunnel--access) | People you list, by email | medium | Sharing with others without a VPN |
| [A reverse proxy with authentication](#4-a-reverse-proxy-that-authenticates) | Whoever has the login | medium | A server that already runs Caddy, Traefik or nginx |

Whichever you choose, also:

- **Set `CREDENTIALS_KEY`** before storing a cookie, a password or a Telegram
  session, so they are encrypted at rest (`openssl rand -base64 48`, and keep a
  copy). See `docs/DEPLOY.md` § Credentials at rest.
- **Keep the image current.** `latest` is rebuilt every week.
- **Do not use a public tunnel without an access policy** — Tailscale Funnel,
  a Cloudflare Tunnel with no Access application, ngrok and the like make it
  public, which is the thing this page exists to prevent.

---

## 1. Keep it on your network

The default compose publishes the port on every interface of the host. That is
fine as long as nothing forwards it from the internet. To make it reachable from
the host alone — for example because a reverse proxy on the same machine will
front it — bind it to loopback:

```yaml
ports:
  - "127.0.0.1:8520:8520"
```

Or to one LAN address only, e.g. `"192.168.1.10:8520:8520"`.

## 2. Tailscale

[Tailscale](https://tailscale.com) puts your devices on a private network of
their own, wherever they are. CasaTube stays unreachable from the internet; your
phone and laptop reach it as if they were at home. Playback and large downloads
go over that link with no limits beyond your connection.

**On the host** (Tailscale already installed there): CasaTube is reachable at
`http://<host>:8520` from your tailnet already. For HTTPS and a clean name:

```bash
tailscale serve --bg 8520
# → https://<host>.<your-tailnet>.ts.net
```

`serve` is private to your tailnet. ⚠️ `funnel` is the public one — do not use
it here.

**As a sidecar**, when the host should not run Tailscale itself:

```yaml
services:
  tailscale:
    image: tailscale/tailscale:latest
    hostname: casatube
    environment:
      TS_AUTHKEY: ${TS_AUTHKEY}          # an auth key from the admin console
      TS_STATE_DIR: /var/lib/tailscale
      TS_SERVE_CONFIG: /config/serve.json
    volumes:
      - ./tailscale/state:/var/lib/tailscale
      - ./tailscale/config:/config
    devices:
      - /dev/net/tun:/dev/net/tun
    cap_add: [net_admin]
    restart: unless-stopped

  casatube:
    image: ghcr.io/xantiagoma/casatube:latest
    network_mode: service:tailscale     # no ports: published at all
    # … environment and volumes as in docker-compose.yml
```

with `./tailscale/config/serve.json`:

```json
{
  "TCP": { "443": { "HTTPS": true } },
  "Web": {
    "${TS_CERT_DOMAIN}:443": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:8520" } } }
  }
}
```

It is then at `https://casatube.<your-tailnet>.ts.net`, and nowhere else.

## 3. Cloudflare Tunnel + Access

A [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
gives CasaTube a public hostname without opening a port, and
[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
puts a login in front of it — a one-time code by email, or your Google or GitHub
account — so only the people you list get through.

1. In the Zero Trust dashboard, **Networks → Tunnels → Create a tunnel**, and
   copy its token.
2. Run `cloudflared` next to CasaTube:

   ```yaml
   services:
     cloudflared:
       image: cloudflare/cloudflared:latest
       command: tunnel --no-autoupdate run
       environment:
         TUNNEL_TOKEN: ${TUNNEL_TOKEN}
       restart: unless-stopped
   ```

   and in the tunnel's **Public hostname** tab, route
   `casatube.example.com` to `http://casatube:8520`.
3. 🔴 **Before using the hostname**, add an application in **Access →
   Applications** for `casatube.example.com` with a policy that allows only your
   email addresses. Without it the tunnel is a public URL.

⚠️ **Video through Cloudflare.** Cloudflare's terms limit serving video and other
large files through its network outside its own video products. Using the UI
through the tunnel is fine; streaming films or downloading multi-gigabyte files
through it may not be, and may be throttled. If you watch from outside the house,
Tailscale is the better fit.

## 4. A reverse proxy that authenticates

If a reverse proxy already terminates TLS for your other apps, put CasaTube
behind it with authentication on **every path** — including `/api`, which is
where the plugin editor and everything else actually live.

Two things the proxy has to get right:

- **`/api/events` is a long-lived stream** (server-sent events). It must not be
  buffered or cut after a minute; CasaTube sends `X-Accel-Buffering: no`, which
  nginx honours, and the read timeout must be long.
- **Video is streamed with range requests** (`/api/library/...`), and a
  downloaded bundle can be gigabytes. No body-size or response-size limits on the
  way out.

### Caddy, with a password

```caddyfile
casatube.example.com {
	basic_auth {
		# caddy hash-password --plaintext 'a long passphrase'
		you $2a$14$...
	}
	reverse_proxy casatube:8520 {
		flush_interval -1
	}
}
```

Basic auth is acceptable **only over HTTPS**, which Caddy provides by default.

### Caddy, with Authelia or Authentik (single sign-on, two factors)

```caddyfile
casatube.example.com {
	forward_auth authelia:9091 {
		uri /api/authz/forward-auth
		copy_headers Remote-User Remote-Groups Remote-Email Remote-Name
	}
	reverse_proxy casatube:8520 {
		flush_interval -1
	}
}
```

The same pattern works with Traefik's `forwardAuth` middleware and with
oauth2-proxy.

### nginx, with a password

```nginx
server {
    listen 443 ssl;
    server_name casatube.example.com;
    # ssl_certificate …

    auth_basic           "CasaTube";
    auth_basic_user_file /etc/nginx/casatube.htpasswd;   # htpasswd -B -c …

    location / {
        proxy_pass         http://casatube:8520;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 1h;           # the event stream stays open
        proxy_buffering    off;          # progress arrives as it happens
        client_max_body_size 0;
    }
}
```

---

## Checking that it worked

From a device that is **not** on your network or tailnet (a phone on mobile
data is the easy one):

- `http://<your-public-ip>:8520` must not answer at all.
- Your hostname must show the login of whatever you put in front, never the
  CasaTube dashboard directly — and the same for
  `https://<your-hostname>/api/health`.
