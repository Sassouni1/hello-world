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
npm create vlix
```

The bridge opens a local console, connects to the desktop agent session store,
and creates account-scoped QR links for phone pairing.

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
