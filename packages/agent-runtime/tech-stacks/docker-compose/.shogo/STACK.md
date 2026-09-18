# Tech Stack — Docker Compose

## Project Structure

Your workspace runs as a **multi-service backend** orchestrated by `docker
compose`. This requires the Docker-capable project class: dockerd running
inside the guest, not the default single-process runtime.

```
docker-compose.yml      ← service definitions (edit this to add/remove services)
app/                     ← your API service's source (Dockerfile + code)
.env                     ← local secrets/config (never committed, never synced)
.env.example             ← documents which vars .env must set
```

## How It Works

1. This runtime does **not** spawn or manage the compose stack for you —
   run it yourself with `exec`, the same as a human would on their laptop.
2. Bring everything up: `exec({ command: "docker compose up -d --build" })`.
   The first build can take a while (base image pulls); it is
   backgrounded automatically if it runs past the exec soft-timeout — poll
   with `exec_wait` or `docker compose ps` rather than assuming it hung.
3. Check state: `exec({ command: "docker compose ps" })`.
4. Logs: `exec({ command: "docker compose logs -f --tail=200 <service>" })`
   (drop `-f` for a one-shot dump; always use `--tail` so agent output
   stays bounded).
5. Run one-off commands inside a service: `exec({ command: "docker compose
   exec app pytest" })`.
6. Tear down: `exec({ command: "docker compose down" })` (add `-v` only if
   you intend to delete named volumes — that is destructive).

## Ports

Services are reachable from inside the guest at `localhost:<port>` as
usual. From outside (the browser/desktop), only the ports listed in this
project's **exposed ports** settings are reachable — by default the app's
HTTP port via the optional public preview, and everything else (e.g. the
database) via the client-side tunnel only. Do not assume a service is
publicly reachable just because it's in `docker-compose.yml`; if the user
needs a new port exposed, tell them to add it in the project's Ports
settings, or use the `expose_port` tool if it's available.

## Important Rules

- `sudo` is blocked in every permission mode — you should never need it.
  `docker` runs without `sudo` in this environment.
- Prefer `docker compose` over bare `docker run` so services share the
  compose network and can reach each other by service name.
- Treat `docker compose up`/`down`/`build` as potentially slow. Don't
  retry a command that's still running; check `docker compose ps` or wait
  on the backgrounded run instead.
- Keep secrets in `.env`, not in `docker-compose.yml` or committed files.
- If a service needs a persistent volume, declare it under `volumes:` in
  `docker-compose.yml` rather than writing into the container's
  ephemeral filesystem.
