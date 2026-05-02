# Vlix

Vlix is a Vite/TanStack web app backed by Supabase, plus a local
desktop bridge that connects a user's real desktop AI agent sessions to the web.

## Run The Web App

```sh
npm install
npm run dev
```

## Install The Desktop Bridge

```sh
npm create vlix@latest
```

The base installer opens a local console. For cloud phone/web access, sign into
the hosted Vlix app and copy the generated `VLIX_BRIDGE_SETUP='...' npm create
vlix@latest` command. That binds the desktop bridge to the user's Supabase account
so phones do not need to be on the same Wi-Fi network.

On macOS, the installer also creates `~/Applications/Vlix.app` with the Vlix icon
so the user can reopen the bridge from Applications or Spotlight.

## Supabase

This repo includes migrations for:

- Bridge accounts
- Paired desktop devices
- Synced sessions
- Messages and live work events
- Queued bridge commands
- Private image/file attachments

Apply migrations with the Supabase CLI after linking the project:

```sh
supabase link --project-ref wneygntolkrnrwoquomz
supabase db push
```

## Environment Variables

Configure these in Lovable/Cloudflare and local `.env` files:

```sh
VITE_SUPABASE_URL=
VITE_SUPABASE_PUBLISHABLE_KEY=
```

Do not commit service-role keys or desktop account secrets.
