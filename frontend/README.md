This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family.

## Local Development

The frontend is a Next.js app. Deployment is local — `bun dev` (or `npm run dev`) on `http://localhost:3000`. The backend runs separately on `http://localhost:8000` via `uvicorn`; see the top-level `start-local.sh` and `backend/.env.example` for setup.

```bash
# In one terminal: backend
cd ..
./.venv/bin/uvicorn backend.main:app --host 0.0.0.0 --port 8000

# In another terminal: this frontend
bun dev
```

To run this frontend against a non-local backend (e.g. a cloudflared
tunnel exposing the backend's `localhost:8000`), set
`NEXT_PUBLIC_BACKEND_URL` in `frontend/.env.local` to the tunnel URL
before `bun dev`.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!
