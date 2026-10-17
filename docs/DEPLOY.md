# Hosting: the web app on Vercel, the data in Supabase

EyeRef has two parts, and they are hosted apart:

- **The web app** (`apps/web`, Next.js). It does all the measuring on the phone and works without a server, so
  on its own it is a complete screening app. Vercel hosts it.
- **The research API** (`backend/`, FastAPI). Only a study needs it: it receives assessments, keeps eye images
  and ground truth, and exports them. Its data go to Supabase: the database to Supabase Postgres, the eye images
  to a private Supabase Storage bucket. The API itself runs from its container image.

Keep every key below in the host's settings for secrets. None of them belongs in the repository, and the
Supabase service-role key must never reach the browser.

## 1. The web app on Vercel

1. In Vercel, import `mysunatislam/eyeref-ai` and set **Root Directory** to `apps/web`. Vercel detects Next.js;
   `npm run build` first fetches the face tracker's files (`scripts/fetch-models.mjs`).
2. Without a research API, set nothing else: the app runs fully on the phone.
3. With one, set `NEXT_PUBLIC_API_URL` to its address (for example `https://api.example.org`). The app's
   content security policy allows that origin and no other.

Vercel builds production from `main`, and a preview from every other branch.

## 2. Supabase

1. Create a project. Under **Database → Connect**, copy a connection string:
   - the **direct** or **session pooler** string (port 5432) for migrations and for a long-running API;
   - the **transaction pooler** string (port 6543) only for a server that starts and stops per request.
     EyeRef sees port 6543 and turns off prepared statements and its own connection pool, which that pooler
     needs.

   A `postgres://` or `postgresql://` string can be used as it is: EyeRef reads it with psycopg 3.
2. Apply the schema once, from `backend/` or in the API's container:

   ```bash
   EYEREF_DATABASE_URL="postgresql://postgres.<ref>:<password>@<host>:5432/postgres" python -m eyeref.db upgrade
   ```
3. Under **Storage**, create a **private** bucket named `eye-images` (or any name, set below). Leave it private:
   the API reads and writes it with the service-role key, and nobody else needs to.

## 3. The research API

Run the container image from `backend/Dockerfile` on any host that keeps a process running (for example
Render, Fly.io, Railway, Google Cloud Run or a virtual machine), with:

| Variable | Value |
| --- | --- |
| `EYEREF_ENV` | `production` (refuses to start without tokens and an image-encryption key) |
| `EYEREF_DATABASE_URL` | the Supabase connection string |
| `EYEREF_SUPABASE_URL` | the project URL, `https://<ref>.supabase.co` |
| `EYEREF_SUPABASE_SERVICE_KEY` | the service-role key (Project settings → API keys) |
| `EYEREF_SUPABASE_BUCKET` | the bucket, if not `eye-images` |
| `EYEREF_STORAGE_KEY` | a Fernet key: images are encrypted before they leave the server |
| `EYEREF_API_TOKENS` | `collect:<token>,analyse:<token>,admin:<token>` ([API](API.md)) |
| `EYEREF_CORS_ORIGINS` | the web app's address on Vercel |

With `EYEREF_SUPABASE_URL` and the service key set, eye images go to the bucket; without them, to
`$EYEREF_DATA_DIR/objects` on the server's disk. `python -m eyeref.api.images` looks after either store.

One thing still lives on the server's disk, under `EYEREF_DATA_DIR`: device profiles saved through the API. Give the container a small lasting volume there, or re-create the profiles after a restart.

### Why not a Vercel Function for the API

The API measures images with OpenCV, NumPy, SciPy and ONNX Runtime, about half a gigabyte unpacked. That is at or
beyond what a Vercel Function may hold, and every cold start would load it. A container keeps it loaded.
