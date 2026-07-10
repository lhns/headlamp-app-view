# syntax=docker/dockerfile:1

# ── build the plugin bundle ──────────────────────────────────────────────────
FROM node:22 AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ── carrier image ────────────────────────────────────────────────────────────
# Just holds the built plugin under /plugins/<name>/. A Headlamp Deployment's
# initContainer copies /plugins/* into its plugins dir (this image never "runs").
FROM alpine:3.20
RUN mkdir -p /plugins/headlamp-app-view
COPY --from=build /src/dist/main.js /plugins/headlamp-app-view/main.js
COPY --from=build /src/package.json /plugins/headlamp-app-view/package.json
CMD ["ls", "-la", "/plugins/headlamp-app-view"]
