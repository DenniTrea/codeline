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

The application has not been scaffolded yet. The existing database schema has
already been applied and is managed through DataGrip.

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
