FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
# Baked in at build time: the backend URL and any extra origins the security policy allows.
# The build also fetches and checksum-verifies the MediaPipe model (scripts/fetch-models.mjs).
ARG NEXT_PUBLIC_API_URL=http://localhost:8000
ARG EYEREF_CSP_CONNECT_SRC=""
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL EYEREF_CSP_CONNECT_SRC=$EYEREF_CSP_CONNECT_SRC NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN adduser -D -u 10001 web
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
USER web
EXPOSE 3000
CMD ["node", "server.js"]
