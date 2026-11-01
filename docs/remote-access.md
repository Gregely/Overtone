# Reaching your server from outside home

Overtone listens on plain HTTP (port 4800). On your home network that works
from a browser, and from the Android app for local names and listed IPs (see
[android.md](android.md#connecting-to-your-server)). Away from home, put
**HTTPS** in front of it. HTTPS also lets browsers install the web app (PWA)
and use its offline shell.

## Option A: Tailscale (recommended, no open ports)

Tailscale puts your server and phone on a private network (tailnet) and can
serve Overtone over HTTPS with an automatically provisioned certificate.

1. Install Tailscale on the server (the Raspberry Pi) and on your phone, and
   sign in to the same tailnet.
2. In the Tailscale admin console, under **DNS**, enable **MagicDNS** and
   **HTTPS Certificates** (see
   [tailscale.com/kb/1153/enabling-https](https://tailscale.com/kb/1153/enabling-https)).
3. On the server:

   ```sh
   tailscale serve --bg --https=443 localhost:4800
   tailscale serve status          # shows https://<machine>.<tailnet>.ts.net
   ```

   It keeps running in the background and survives reboots. To stop it:
   `tailscale serve --https=443 localhost:4800 off`.
4. In the Overtone app or browser, use `https://<machine>.<tailnet>.ts.net`
   as the server address.

Only devices in your tailnet can reach it. Nothing is exposed to the
internet.

## Option B: reverse proxy with a public domain (Caddy)

Use this if you want a normal URL such as `https://music.example.com`. You
need a domain pointing at your home IP, and ports 80/443 forwarded to the
server.

`Caddyfile`:

```caddyfile
music.example.com {
    encode zstd gzip
    reverse_proxy localhost:4800
}
```

Caddy obtains and renews Let's Encrypt certificates automatically. Then set
`OVERTONE_TRUST_PROXY=true` in `.env`, so Overtone sees the real client IP
for rate limiting, and restart Overtone.

This exposes the login page to the internet. Overtone rate-limits sign-in
attempts, but choose a strong password and keep the server updated. Option A
avoids this exposure entirely.

## Origins

The web app served by Overtone needs no CORS configuration. The Android app
(`http://localhost` / `https://localhost`) is allowed by default. If you host
the web app on a different origin, add it to `OVERTONE_CORS_ORIGINS`.
