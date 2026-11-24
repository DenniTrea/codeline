# CodeLine

Classroom coding exercises and live games.

## Planned stack

- Frontend: React, TypeScript, Vite, Tailwind CSS
- Backend: Node.js, Express, TypeScript, Socket.IO
- Database: PostgreSQL
- Authentication: Microsoft Entra ID with MSAL
- Hosting: Azure Ubuntu VM with Nginx

## Repository structure

```text
frontend/  Web application
backend/   API and live game server
docs/      Project documentation
```

The initial frontend and backend are scaffolded. The existing database schema
has already been applied and is managed through DataGrip. No migrations run on
startup. See [development instructions](docs/development.txt) for setup, current
limitations, Microsoft registration and verification.

```bash
npm ci
npm run dev
```

Open http://localhost:5173. The backend uses port 3001 to avoid the existing
PostgREST service on port 3000. Real Microsoft sign-in requires Entra setup;
course creation requires an explicitly approved lecturer or admin account.

## Local configuration

Copy `backend/.env.example` to `backend/.env` and fill in local settings when
building the backend. Environment loading will be configured with the backend.
Keep database passwords and Azure private keys out of commits. Frontend build
variables are public: database credentials belong only in the backend.

## Git workflow

The default branch is `main`. Create one branch per feature:

```bash
git switch -c feat/course-management
git add <specific-files>
git diff --cached
git commit -m "feat: add course management"
```

Connect an existing GitHub repository as `origin` before pushing. Avoid committing
real `.env` files, database exports, private keys, or student data.
