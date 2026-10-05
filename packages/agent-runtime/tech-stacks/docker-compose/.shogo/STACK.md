# Tech Stack — Docker Compose

This project runs on a Docker-capable machine. `docker` and `docker compose` work here. The daemon is already running; do not install Docker or start it with sudo.

## Project Structure

Your workspace runs as a **multi-service backend** orchestrated by `docker compose`.

```
docker-compose.yml      ← service definitions (edit this to add/remove services)
app/                     ← your API service's source (Dockerfile + code)
.env                     ← local secrets/config (never committed, never synced)
.env.example             ← documents which vars .env must set
```

## How It Works

1. This runtime does **not** spawn or manage the compose stack for you — run it yourself with `exec`, the same as a human would on their laptop.
2. Bring everything up: `exec({ command: "docker compose up -d --build" })`. The first build can take a while (base image pulls); it is backgrounded automatically if it runs past the exec soft-timeout — poll with `exec_wait` or `docker compose ps` rather than assuming it hung.
3. Check state: `exec({ command: "docker compose ps" })`.
4. Logs: `exec({ command: "docker compose logs --tail=200 <service>" })`. Always use `--tail` so agent output stays bounded.
5. Run one-off commands inside a service: `exec({ command: "docker compose exec app pytest" })`.
6. Tear down: `exec({ command: "docker compose down" })` (add `-v` only if you intend to delete named volumes — that is destructive).

## Preview

Studio shows the app through an exposed HTTP port, at `https://<port>--<project>.preview…`. The default preview port is **8000**. Postgres on 5432 is a private tunnel, not a web preview.

If the app listens on a different port, call `expose_port` with that port and `protocol: "http"`. A new port is private until the user approves making it public. Check `docker compose ps` for the published ports.

The preview forwards the browser's cookies and Authorization header, and it streams Server-Sent Events. Vite hot reload needs the dev server to accept the preview hostname (`server.allowedHosts: true`, or an edge proxy that rewrites Host).

Image layers and named volumes live on a data disk that stays with this machine. Moving the project to another host starts that disk over.

## Important Rules

- `sudo` is blocked in every permission mode — you should never need it. `docker` runs without `sudo` in this environment.
- Prefer `docker compose` over bare `docker run` so services share the compose network and can reach each other by service name.
- Treat `docker compose up`/`down`/`build` as potentially slow. Don't retry a command that's still running; check `docker compose ps` or wait on the backgrounded run instead.
- Keep secrets in `.env`, not in `docker-compose.yml` or committed files.
- If a service needs a persistent volume, declare it under `volumes:` in `docker-compose.yml` rather than writing into the container's ephemeral filesystem.
