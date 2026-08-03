# Single image that can run either the web dashboard or the processing worker.
# Build once; choose the process at `docker run` time via the command.
#
#   Web dashboard:   docker run --env-file .env -p 3000:3000 voiceover-tool
#   Worker:          docker run --env-file .env voiceover-tool npm run worker
#
# (In production, run them as TWO separate containers/services.)

FROM node:20-slim

WORKDIR /app

# Install all deps (incl. tsx, which the worker needs at runtime).
COPY package.json package-lock.json* ./
RUN npm ci

# App source + build the Next.js dashboard.
COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000

# Default to the web dashboard; override with `npm run worker` for the worker.
CMD ["npm", "start"]
