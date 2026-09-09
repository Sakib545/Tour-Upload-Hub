# Tour Upload Hub — single-stage Node build.
# A Dockerfile makes Railway build with Docker instead of Railpack, which also
# sidesteps Railpack download failures on Railway's side.
#
# Runtime notes:
#  - PORT is injected by Railway (defaults to 3000 locally).
#  - Face models (FACE_SORT=true or hero enrolment) are downloaded by the app
#    into ./data/face-models on first boot — runtime has network access.
#  - Site settings/persons are stored in Google Drive, so ./data is disposable.

FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

# Install every dependency (including the optional face/vision packages) so
# enrolment + hero photo mode work out of the box.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .

# Non-root user for the runtime
RUN chown -R node:node /app && mkdir -p /app/data && chown -R node:node /app/data
USER node

EXPOSE 3000

CMD ["node", "server/server.js"]
