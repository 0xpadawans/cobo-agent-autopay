# Database Setup

This project uses Prisma with SQLite for local demos by default.

## Configuration

Copy the example environment file:

```bash
cp .env.example .env
```

Database configuration lives in `.env`:

```bash
DATABASE_URL="file:./dev.db"
STORAGE_DRIVER=prisma
```

Because `prisma/schema.prisma` is inside the `prisma/` directory, `file:./dev.db`
creates the database at:

```text
prisma/dev.db
```

Use `STORAGE_DRIVER=prisma` for demos. `STORAGE_DRIVER=memory` is only for
throwaway development and resets data when the dev server restarts.

## Initialize Or Reuse Database

Run:

```bash
npm run db:init
```

The script is idempotent:

- If `prisma/dev.db` does not exist, it creates the SQLite file.
- If the database already exists, it keeps it.
- It runs `prisma generate`.
- It runs `prisma migrate deploy`.
- If migrations are already applied, Prisma reports that the schema is up to date.

## Start The App

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

## Fresh Demo Machine Checklist

```bash
npm install
cp .env.example .env
npm run db:init
npm run dev
```

Then log in with an email address. Each email creates an isolated user record,
and each user's CAW CLI home is stored under:

```text
.caw-cli-homes/<userId>
```

## Optional Postgres Note

The current Prisma schema is configured for SQLite. If you want to use Postgres
later, change the Prisma datasource provider in `prisma/schema.prisma`, update
`DATABASE_URL`, and create a matching migration set.
